import crypto from "node:crypto";

import { getPerpsRuntimeOverride } from "@/lib/perps/auditLog";
import {
  getActivePerpsAsset,
  isPerpsAutomationEnabled,
  type PerpsAutomationConfig,
} from "@/lib/perps/automationConfig";
import { disablePerpsScalpMode, listPerpsAutomationConfigs } from "@/lib/perps/automationConfigStore";
import { getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import { getPerpsSessionConfig, isPerpsLiveWalletAllowed } from "@/lib/perps/sessionConfig";
import { listPerpsSessions } from "@/lib/perps/sessionStore";
import type { PerpsAutomationSession } from "@/lib/perps/sessionTypes";
import { routePerpsSignalForUser } from "@/lib/perps/tradingAgent";
import { listUserPerpsExecutions, reconcileUserExecutionsWithoutOpenPosition } from "@/lib/perps/userExecutionAudit";
import { getWalletUsdcBalance } from "@/lib/perps/walletBalance";
import { fetchJupiterPerpsAccountSnapshot } from "@/lib/jupiterPerps";
import { fetchCoinbaseMinuteCandles } from "@/lib/price/coinbase";
import type { PricePoint } from "@/lib/price/simulated";
import { computeSignalMetrics, detectSignals, type Signal } from "@/lib/signal/engine";
import {
  BASE_INDICATOR_SETTINGS,
  computeIndicatorSnapshot,
  scoreIndicatorSnapshot,
  type IndicatorSnapshot,
  type IndicatorSettings,
} from "@/lib/signal/indicators";
import { getRedisClient } from "@/lib/server/redis";
import { getActiveDecisionLearningProfile } from "@/lib/decision/learningStore";
import { getLearnedSignalParams, applyLearnedTradePlan } from "@/lib/decision/learningRuntime";
import { listTradeDecisionRecords } from "@/lib/decision/logStore";
import { reconcileTradeLearningOutcomes } from "@/lib/decision/outcomeReconciler";
import { trainWalletDecisionProfile } from "@/lib/decision/trainer";
import type { DecisionLearningProfile } from "@/lib/decision/learningTypes";

const MONITOR_LOCK_KEY = "brembot:perps:automation:monitor-lock";
const LAST_SIGNAL_KEY = "brembot:perps:automation:last-signal";
const LAST_RUN_KEY = "brembot:perps:automation:last-run";
const MONITOR_LOCK_TTL_MS = 55_000;
const MIN_PERPS_COLLATERAL_USD = 10;
const MIN_TPSL_EXPECTED_PNL_USD = 1;

type AutonomousSignal = Omit<Signal, "type"> & { type: Signal["type"] | "scalp" };

type MonitorExecutionResult = {
  walletAddress: string;
  asset: "SOL" | "ETH" | "BTC" | null;
  status: "executed" | "skipped" | "failed";
  code: string;
  message: string;
  signalId?: string;
};

export type AutonomousMonitorResult = {
  ok: boolean;
  locked: boolean;
  startedAt: string;
  completedAt: string;
  configuredWallets: number;
  eligibleWallets: number;
  results: MonitorExecutionResult[];
};

type MonitorDependencies = {
  listConfigs: typeof listPerpsAutomationConfigs;
  listSessions: typeof listPerpsSessions;
  getRuntimeOverride: typeof getPerpsRuntimeOverride;
  fetchCandles: typeof fetchCoinbaseMinuteCandles;
  fetchSnapshot: typeof fetchJupiterPerpsAccountSnapshot;
  getUsdcBalance: typeof getWalletUsdcBalance;
  routeSignal: typeof routePerpsSignalForUser;
  reconcileNoOpenPosition: typeof reconcileUserExecutionsWithoutOpenPosition;
  getAgentWallet: typeof getAgentWalletForOwner;
  isWalletAllowed: typeof isPerpsLiveWalletAllowed;
  getLearningProfile: (walletAddress: string) => Promise<DecisionLearningProfile | null>;
  reconcileLearningHistory: (walletAddress: string, snapshot: Awaited<ReturnType<typeof fetchJupiterPerpsAccountSnapshot>>) => Promise<number>;
  autoTrain: (walletAddress: string, config: PerpsAutomationConfig) => Promise<void>;
  disableScalpMode: (walletAddress: string) => Promise<PerpsAutomationConfig | null>;
  readLastSignal: (walletAddress: string, asset: string) => Promise<number | null>;
  writeLastSignal: (walletAddress: string, asset: string, timestamp: number) => Promise<void>;
};

const defaultDependencies: MonitorDependencies = {
  listConfigs: listPerpsAutomationConfigs,
  listSessions: listPerpsSessions,
  getRuntimeOverride: getPerpsRuntimeOverride,
  fetchCandles: fetchCoinbaseMinuteCandles,
  fetchSnapshot: fetchJupiterPerpsAccountSnapshot,
  getUsdcBalance: getWalletUsdcBalance,
  routeSignal: routePerpsSignalForUser,
  reconcileNoOpenPosition: reconcileUserExecutionsWithoutOpenPosition,
  getAgentWallet: getAgentWalletForOwner,
  isWalletAllowed: isPerpsLiveWalletAllowed,
  getLearningProfile: getActiveDecisionLearningProfile,
  reconcileLearningHistory: async (walletAddress, snapshot) => {
    const [executions, decisions] = await Promise.all([
      listUserPerpsExecutions(walletAddress),
      listTradeDecisionRecords(2_000, walletAddress),
    ]);
    const outcomes = await reconcileTradeLearningOutcomes({ walletAddress, executions, decisions, snapshot });
    return outcomes.length;
  },
  autoTrain: async (walletAddress, config) => {
    await trainWalletDecisionProfile({ walletAddress, config, source: "automatic" });
  },
  disableScalpMode: disablePerpsScalpMode,
  readLastSignal: async (walletAddress, asset) => {
    const redis = await getRedisClient();
    if (!redis) return null;
    const value = await redis.hGet(LAST_SIGNAL_KEY, `${walletAddress}:${asset}`);
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  },
  writeLastSignal: async (walletAddress, asset, timestamp) => {
    const redis = await getRedisClient();
    if (!redis) throw new Error("Redis is unavailable while saving the autonomous signal cursor.");
    await redis.hSet(LAST_SIGNAL_KEY, `${walletAddress}:${asset}`, String(timestamp));
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function computeVolatilityPercent(points: PricePoint[]) {
  const values = points.map((point) => point.v).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 2) return 0;
  const current = values[values.length - 1] ?? 0;
  return current > 0 ? ((Math.max(...values) - Math.min(...values)) / current) * 100 : 0;
}

function computeTrendBias(points: PricePoint[]): "bullish" | "bearish" | "sideways" {
  if (points.length < 2) return "sideways";
  const first = points[0]?.v ?? 0;
  const last = points[points.length - 1]?.v ?? 0;
  if (first <= 0 || last <= 0) return "sideways";
  const change = ((last - first) / first) * 100;
  if (change >= 1) return "bullish";
  if (change <= -1) return "bearish";
  return "sideways";
}

export function detectScalpSignal(options: {
  symbol: string;
  points: PricePoint[];
  indicators: IndicatorSnapshot;
  cooldownSeconds: number;
  lastSignalAt?: number | null;
}): AutonomousSignal | null {
  const { points, indicators } = options;
  const latest = points[points.length - 1];
  if (!latest || points.length < 3) return null;
  if (options.lastSignalAt && latest.t - options.lastSignalAt < options.cooldownSeconds * 1_000) return null;
  if (computeTrendBias(points) !== "sideways") return null;
  if (
    indicators.adx === null
    || indicators.adx > 20
    || indicators.emaSpreadPercent === null
    || Math.abs(indicators.emaSpreadPercent) > 0.35
    || indicators.atrPercent === null
    || indicators.atrPercent < 0.02
    || indicators.bollingerBandwidthPercent === null
    || indicators.bollingerBandwidthPercent < 0.1
    || indicators.bollingerPosition === null
    || indicators.rsi === null
  ) return null;

  const longSetup = indicators.bollingerPosition <= 0.2 && indicators.rsi <= 45;
  const shortSetup = indicators.bollingerPosition >= 0.8 && indicators.rsi >= 55;
  if (!longSetup && !shortSetup) return null;
  const direction = longSetup ? "bullish" : "bearish";
  const bandExtremity = longSetup
    ? clamp((0.2 - indicators.bollingerPosition) / 0.2, 0, 1)
    : clamp((indicators.bollingerPosition - 0.8) / 0.2, 0, 1);
  const rsiExtremity = longSetup
    ? clamp((45 - indicators.rsi) / 20, 0, 1)
    : clamp((indicators.rsi - 55) / 20, 0, 1);
  const confidence = Number(clamp(0.6 + bandExtremity * 0.12 + rsiExtremity * 0.08, 0.6, 0.8).toFixed(3));
  return {
    id: `${options.symbol}-scalp-${latest.t}`,
    symbol: options.symbol,
    type: "scalp",
    direction,
    confidence,
    summary: `${direction === "bullish" ? "Range-low" : "Range-high"} scalp setup at Bollinger position ${indicators.bollingerPosition.toFixed(2)} with RSI ${indicators.rsi.toFixed(1)}.`,
    timestamp: latest.t,
  };
}

function getIndicatorSettings(profile: DecisionLearningProfile | null): IndicatorSettings {
  const learned = profile?.indicatorSettings;
  return learned ? {
    ...BASE_INDICATOR_SETTINGS,
    ...learned,
  } : BASE_INDICATOR_SETTINGS;
}

function getCollateralPercent(config: PerpsAutomationConfig, availableUsdc: number) {
  if (availableUsdc <= 0) return 0;
  return config.settings.walletAllocationMode === "usd"
    ? clamp((config.settings.walletPercent / availableUsdc) * 100, 0, 100)
    : clamp(config.settings.walletPercent, 1, 100);
}

function deriveTradePlan(config: PerpsAutomationConfig, points: PricePoint[], signal: AutonomousSignal, availableUsdc: number) {
  const baseCollateralPercent = getCollateralPercent(config, availableUsdc);
  const volatilityPercent = computeVolatilityPercent(points);
  if (config.settings.perpsExecutionMode !== "smart-trades" || config.settings.decisionMode === "shadow") {
    return {
      collateralPercent: baseCollateralPercent,
      leverage: config.settings.perpsLeverage,
      stopLossPercent: config.settings.stopLossPercent,
      takeProfitPercent: config.settings.perpsTakeProfitMode === "percent" ? config.settings.perpsTakeProfitValue : 0,
      volatilityPercent,
    };
  }

  const profile = {
    conservative: { collateralBase: 0.4, leverageBase: 0.3, defaultTp: 0.9, defaultSl: 1.5, leverageCapMultiplier: 0.45 },
    balanced: { collateralBase: 0.65, leverageBase: 0.5, defaultTp: 1.5, defaultSl: 3.5, leverageCapMultiplier: 0.65 },
    aggressive: { collateralBase: 0.8, leverageBase: 1.35, defaultTp: 3, defaultSl: 7, leverageCapMultiplier: 2 },
  }[config.settings.smartTradeProfile];
  const volatilityFactor = clamp(volatilityPercent / 2.5, 0, 1.35);
  const confidenceBias = clamp((signal.confidence - 0.55) / 0.35, -0.5, 1);
  const collateralPercent = clamp(
    baseCollateralPercent * (profile.collateralBase + confidenceBias * 0.18 - volatilityFactor * 0.16),
    Math.min(5, baseCollateralPercent),
    100
  );
  const leverage = clamp(
    config.settings.perpsLeverage * (profile.leverageBase + confidenceBias * 0.12 - volatilityFactor * 0.14),
    1,
    Math.min(250, Math.max(1, config.settings.perpsLeverage * profile.leverageCapMultiplier))
  );
  const baseTp = config.settings.perpsTakeProfitMode === "percent" && config.settings.perpsTakeProfitValue > 0
    ? config.settings.perpsTakeProfitValue
    : profile.defaultTp;
  const baseSl = config.settings.stopLossPercent > 0 ? config.settings.stopLossPercent : profile.defaultSl;

  return {
    collateralPercent: Number(collateralPercent.toFixed(2)),
    leverage: Number(leverage.toFixed(2)),
    stopLossPercent: Number(clamp(baseSl * (1 + volatilityFactor * 0.18 - confidenceBias * 0.06), 0.2, 5).toFixed(2)),
    takeProfitPercent: Number(clamp(baseTp * (1 + volatilityFactor * 0.28 + confidenceBias * 0.08), 0.2, 6).toFixed(2)),
    volatilityPercent: Number(volatilityPercent.toFixed(2)),
  };
}

export function computeTriggerPrices(options: {
  config: PerpsAutomationConfig;
  entryPrice: number;
  collateralUsd: number;
  leverage: number;
  side: "long" | "short";
  stopLossPercent: number;
  takeProfitPercent: number;
  takeProfitUsd?: number;
}) {
  const direction = options.side === "long" ? 1 : -1;
  const positionSizeUsd = options.collateralUsd * options.leverage;
  const requestedTakeProfitMove = typeof options.takeProfitUsd === "number"
    ? (positionSizeUsd > 0 ? Math.max(2, options.takeProfitUsd) / positionSizeUsd : 0)
    : options.config.settings.perpsTakeProfitMode === "usd"
    ? (positionSizeUsd > 0 ? options.config.settings.perpsTakeProfitValue / positionSizeUsd : 0)
    : options.takeProfitPercent > 0 ? options.takeProfitPercent / 100 / options.leverage : 0;
  const requestedStopLossMove = options.stopLossPercent > 0 ? options.stopLossPercent / 100 / options.leverage : 0;
  const minimumTriggerMove = positionSizeUsd > 0 ? MIN_TPSL_EXPECTED_PNL_USD / positionSizeUsd : 0;
  const takeProfitMove = requestedTakeProfitMove > 0 ? Math.max(requestedTakeProfitMove, minimumTriggerMove) : 0;
  const stopLossMove = requestedStopLossMove > 0 ? Math.max(requestedStopLossMove, minimumTriggerMove) : 0;
  return {
    takeProfitPrice: takeProfitMove > 0 ? options.entryPrice * (1 + direction * takeProfitMove) : null,
    stopLossPrice: stopLossMove > 0 ? options.entryPrice * (1 - direction * stopLossMove) : null,
  };
}

function getSessionForConfig(config: PerpsAutomationConfig, sessions: PerpsAutomationSession[]) {
  return sessions.find((session) => session.walletAddress === config.walletAddress) ?? null;
}

function skip(config: PerpsAutomationConfig, asset: "SOL" | "ETH" | "BTC" | null, code: string, message: string): MonitorExecutionResult {
  return { walletAddress: config.walletAddress, asset, status: "skipped", code, message };
}

export async function runAutonomousPerpsMonitor(
  overrides: Partial<MonitorDependencies> = {}
): Promise<AutonomousMonitorResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const startedAt = new Date().toISOString();
  const [configs, sessions, runtimeOverride] = await Promise.all([
    deps.listConfigs(),
    deps.listSessions(),
    deps.getRuntimeOverride(),
  ]);
  const globalKillSwitch = runtimeOverride.killSwitchOverride ?? getPerpsSessionConfig().globalKillSwitch;
  const enabledConfigs = configs.filter(isPerpsAutomationEnabled);
  const results: MonitorExecutionResult[] = [];

  for (const config of enabledConfigs) {
    const asset = getActivePerpsAsset(config);
    if (!asset) continue;
    const session = getSessionForConfig(config, sessions);
    if (!session || session.sessionState !== "clocked_in") {
      results.push(skip(config, asset, "SESSION_INACTIVE", "The autonomous Perps session is not clocked in."));
      continue;
    }
    if (session.mode !== "live" || session.executionModel !== "delegated-ready") {
      results.push(skip(config, asset, "SESSION_NOT_DELEGATED", "The session is not a delegated-ready live session."));
      continue;
    }
    if (globalKillSwitch || session.killSwitch) {
      results.push(skip(config, asset, "KILL_SWITCH", "The Perps kill switch is enabled."));
      continue;
    }
    if (!deps.isWalletAllowed(config.walletAddress)) {
      results.push(skip(config, asset, "WALLET_NOT_ALLOWED", "The primary wallet is not in the live Perps allowlist."));
      continue;
    }

    try {
      const agentWallet = deps.getAgentWallet(config.walletAddress);
      if (!agentWallet) throw new Error("No autonomous wallet is associated with this primary wallet.");
      const learningProfile = await deps.getLearningProfile(config.walletAddress);
      const executionProfile = config.settings.perpsExecutionMode === "smart-trades"
        && config.settings.decisionMode === "active"
        ? learningProfile
        : null;
      const effectiveParams = getLearnedSignalParams(config, asset, executionProfile);
      const [snapshot, availableUsdc, points] = await Promise.all([
        deps.fetchSnapshot(agentWallet),
        deps.getUsdcBalance(agentWallet),
        deps.fetchCandles(`${asset}-USD`, Math.max(60, effectiveParams.trendWindow + 35)),
      ]);
      const reconciledOutcomeCount = await deps.reconcileLearningHistory(config.walletAddress, snapshot).catch(() => 0);
      if (reconciledOutcomeCount > 0) {
        await deps.autoTrain(config.walletAddress, config).catch(() => undefined);
      }
      const openPositions = snapshot.positions.filter((position) => position.source !== "mock");
      if (openPositions.length > 0) {
        results.push(skip(config, asset, "POSITION_ALREADY_OPEN", "An agent-owned Perps position is already open."));
        continue;
      }
      await deps.reconcileNoOpenPosition(config.walletAddress);
      if (availableUsdc === null || availableUsdc <= 0) {
        results.push(skip(config, asset, "NO_COLLATERAL", "The autonomous wallet has no available USDC collateral."));
        continue;
      }

      const latestTimestamp = points[points.length - 1]?.t ?? 0;
      const windowStart = latestTimestamp - effectiveParams.trendWindow * 60_000;
      const windowPoints = points.filter((point) => point.t >= windowStart);
      if (windowPoints.length < 3) {
        results.push(skip(config, asset, "INSUFFICIENT_MARKET_DATA", "Coinbase did not return enough completed minute candles."));
        continue;
      }
      const lastSignalAt = await deps.readLastSignal(config.walletAddress, asset);
      const volatilityPercent = computeVolatilityPercent(windowPoints);
      const signalMetrics = computeSignalMetrics(windowPoints);
      const smartSignalCandidate = detectSignals({
        symbol: `${asset}/USD`,
        points: windowPoints,
        params: effectiveParams,
      })[0];
      const smartSignal = detectSignals({
        symbol: `${asset}/USD`,
        points: windowPoints,
        params: effectiveParams,
        lastSignalAt: lastSignalAt ?? undefined,
      })[0];
      const indicatorSettings = getIndicatorSettings(learningProfile);
      const indicators = computeIndicatorSnapshot(points, indicatorSettings);
      const scalpSignal = !smartSignalCandidate && config.settings.scalpModeEnabled
        ? detectScalpSignal({
            symbol: `${asset}/USD`,
            points: windowPoints,
            indicators,
            cooldownSeconds: effectiveParams.cooldownSeconds,
            lastSignalAt,
          })
        : null;
      const signal = smartSignal ?? scalpSignal;
      const strategyClass = scalpSignal ? "scalp" as const : "smart" as const;
      if (!signal) {
        results.push(skip(
          config,
          asset,
          smartSignalCandidate ? "SMART_SIGNAL_COOLDOWN" : "NO_SIGNAL",
          smartSignalCandidate
            ? "A trend or breakout candidate was detected, but the shared signal cooldown is still active. Scalp Mode remains enabled until a smart trade is taken."
            : config.settings.scalpModeEnabled
              ? "No qualifying smart or sideways-market scalp signal was detected in the latest candle window."
              : "No qualifying signal was detected in the latest candle window."
        ));
        continue;
      }
      if (executionProfile && volatilityPercent > executionProfile.volatilityCeilingPercent) {
        results.push(skip(config, asset, "LEARNED_VOLATILITY_SKIP", `Current ${volatilityPercent.toFixed(2)}% volatility exceeds the trained ${executionProfile.volatilityCeilingPercent.toFixed(2)}% ceiling.`));
        continue;
      }
      const indicatorScore = strategyClass === "scalp"
        ? {
            score: Number((signal.confidence * 5).toFixed(2)),
            qualified: true,
            vetoed: false,
            tags: ["SCALP_RANGE", signal.direction === "bullish" ? "SCALP_RANGE_LOW" : "SCALP_RANGE_HIGH"],
          }
        : scoreIndicatorSnapshot(indicators, signal.direction, indicatorSettings);
      const indicatorsReady = indicators.emaFast !== null
        && indicators.emaSlow !== null
        && indicators.rsi !== null
        && indicators.macdHistogram !== null
        && indicators.adx !== null;
      if (strategyClass === "smart" && indicatorsReady && !indicatorScore.qualified) {
        await deps.writeLastSignal(config.walletAddress, asset, signal.timestamp);
        results.push(skip(
          config,
          asset,
          indicatorScore.vetoed ? "INDICATOR_RSI_VETO" : "INDICATOR_CONFIRMATION_SKIP",
          indicatorScore.vetoed
            ? `The ${signal.direction} candidate was skipped by the RSI extreme veto (${indicators.rsi?.toFixed(1)}).`
            : `The ${signal.direction} candidate scored ${indicatorScore.score.toFixed(1)} of the required ${indicatorSettings.minimumScore.toFixed(1)} indicator points.`
        ));
        continue;
      }
      if (strategyClass === "smart" && executionProfile) {
        const trendQualified = Math.abs(signalMetrics.trend.changePercent) >= effectiveParams.trendThreshold;
        const breakoutMetric = Math.abs(signalMetrics.breakoutChange) >= effectiveParams.breakoutPercent
          ? signalMetrics.breakoutChange
          : signalMetrics.shortMomentum;
        const breakoutQualified = Math.abs(breakoutMetric) >= effectiveParams.breakoutPercent * 0.6;
        const trendDirection = signalMetrics.trend.changePercent >= 0 ? "bullish" : "bearish";
        const breakoutDirection = breakoutMetric >= 0 ? "bullish" : "bearish";
        if (!trendQualified || !breakoutQualified || trendDirection !== breakoutDirection || signal.direction !== trendDirection) {
          await deps.writeLastSignal(config.walletAddress, asset, signal.timestamp);
          results.push(skip(config, asset, "LEARNED_CONFIRMATION_SKIP", "The signal did not have matching trend and breakout confirmation under the active trained profile."));
          continue;
        }
      }
      if (config.settings.mode === "buy-only" && signal.direction === "bearish") {
        await deps.writeLastSignal(config.walletAddress, asset, signal.timestamp);
        results.push(skip(config, asset, "BUY_ONLY_SKIP", "Buy-only mode skipped the bearish Perps signal."));
        continue;
      }
      if (
        strategyClass === "smart"
        && executionProfile
        && executionProfile.preferredDirection !== "balanced"
        && signal.direction !== executionProfile.preferredDirection
      ) {
        await deps.writeLastSignal(config.walletAddress, asset, signal.timestamp);
        results.push(skip(config, asset, "LEARNED_DIRECTION_SKIP", `The active trained profile currently prefers ${executionProfile.preferredDirection} setups.`));
        continue;
      }

      const planningConfig = strategyClass === "scalp"
        ? { ...config, settings: { ...config.settings, perpsExecutionMode: "set-parameters" as const } }
        : config;
      const basePlan = deriveTradePlan(planningConfig, windowPoints, signal, availableUsdc);
      const plan = applyLearnedTradePlan({
        basePlan,
        asset,
        points: windowPoints,
        profile: strategyClass === "smart" ? executionProfile : null,
      });
      const collateralUsd = Number((availableUsdc * plan.collateralPercent / 100).toFixed(6));
      if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
        results.push(skip(config, asset, "NO_COLLATERAL", "The configured allocation produced no usable USDC collateral."));
        continue;
      }
      if (collateralUsd < MIN_PERPS_COLLATERAL_USD) {
        await deps.writeLastSignal(config.walletAddress, asset, signal.timestamp);
        results.push(skip(
          config,
          asset,
          "COLLATERAL_BELOW_MINIMUM",
          `The configured allocation produced $${collateralUsd.toFixed(2)} of collateral; Jupiter requires at least $${MIN_PERPS_COLLATERAL_USD.toFixed(2)}.`
        ));
        continue;
      }
      const side = signal.direction === "bullish" ? "long" : "short";
      const entryPrice = windowPoints[windowPoints.length - 1]?.v ?? 0;
      const triggers = computeTriggerPrices({
        config,
        entryPrice,
        collateralUsd,
        leverage: plan.leverage,
        side,
        stopLossPercent: plan.stopLossPercent,
        takeProfitPercent: plan.takeProfitPercent,
        takeProfitUsd: strategyClass === "scalp" ? config.settings.scalpTakeProfitUsd : undefined,
      });
      const firstPrice = windowPoints[0]?.v ?? entryPrice;
      const recentPriceChangePercent = firstPrice > 0 ? ((entryPrice - firstPrice) / firstPrice) * 100 : 0;
      const routed = await deps.routeSignal(config.walletAddress, {
        signalId: signal.id,
        symbol: signal.symbol,
        summary: `${signal.summary} Server monitor ${new Date(signal.timestamp).toISOString()}.`,
        direction: signal.direction,
        signalConfidence: signal.confidence,
        asset,
        collateralUsd,
        leverage: plan.leverage,
        takeProfitPrice: triggers.takeProfitPrice,
        stopLossPrice: triggers.stopLossPrice,
        maxSlippageBps: 100,
        smartTradeProfile: config.settings.smartTradeProfile,
        executionStyle: strategyClass === "scalp" ? "set-parameters" : config.settings.perpsExecutionMode,
        strategyClass,
        strategyContext: {
          signalType: signal.type,
          trendWindow: effectiveParams.trendWindow,
          trendThreshold: effectiveParams.trendThreshold,
          breakoutPercent: effectiveParams.breakoutPercent,
          cooldownSeconds: effectiveParams.cooldownSeconds,
          trendStrengthPercent: signalMetrics.trend.changePercent,
          breakoutStrengthPercent: signalMetrics.breakoutChange,
          atrPercent: plan.atrPercent,
          indicatorScore: indicatorScore.score,
          indicatorQualified: indicatorsReady ? indicatorScore.qualified : false,
          indicatorTags: indicatorsReady ? indicatorScore.tags : ["INDICATOR_HISTORY_INCOMPLETE"],
          indicators: {
            emaSpreadPercent: indicators.emaSpreadPercent,
            emaSlopePercent: indicators.emaSlopePercent,
            rsi: indicators.rsi,
            macdLine: indicators.macdLine,
            macdSignal: indicators.macdSignal,
            macdHistogram: indicators.macdHistogram,
            macdHistogramChange: indicators.macdHistogramChange,
            adx: indicators.adx,
            plusDi: indicators.plusDi,
            minusDi: indicators.minusDi,
            volumeRatio: indicators.volumeRatio,
            bollingerBandwidthPercent: indicators.bollingerBandwidthPercent,
            bollingerPosition: indicators.bollingerPosition,
          },
          learningProfileId: plan.profileId,
        },
        marketContext: {
          spotPrice: entryPrice,
          volatilityPercent: plan.volatilityPercent,
          trendBias: computeTrendBias(windowPoints),
          availableUsdc,
          hasOpenPosition: false,
          recentPriceChangePercent,
        },
      });
      await deps.writeLastSignal(config.walletAddress, asset, signal.timestamp);
      if (routed.ok && strategyClass === "smart" && config.settings.scalpModeEnabled) {
        await deps.disableScalpMode(config.walletAddress);
      }
      results.push({
        walletAddress: config.walletAddress,
        asset,
        status: routed.ok ? "executed" : "skipped",
        code: "code" in routed && typeof routed.code === "string" ? routed.code : routed.ok ? "EXECUTED" : "NOT_EXECUTED",
        message: routed.message,
        signalId: signal.id,
      });
    } catch (error) {
      results.push({
        walletAddress: config.walletAddress,
        asset,
        status: "failed",
        code: "MONITOR_ERROR",
        message: error instanceof Error ? error.message : "Autonomous Perps monitoring failed.",
      });
    }
  }

  const completedAt = new Date().toISOString();
  return {
    ok: !results.some((result) => result.status === "failed"),
    locked: true,
    startedAt,
    completedAt,
    configuredWallets: configs.length,
    eligibleWallets: enabledConfigs.length,
    results,
  };
}

export async function runLockedAutonomousPerpsMonitor() {
  const redis = await getRedisClient();
  if (!redis) throw new Error("Redis is required for the autonomous Perps monitor.");
  const lockToken = crypto.randomUUID();
  const acquired = await redis.set(MONITOR_LOCK_KEY, lockToken, { NX: true, PX: MONITOR_LOCK_TTL_MS });
  if (acquired !== "OK") {
    const now = new Date().toISOString();
    return {
      ok: true,
      locked: false,
      startedAt: now,
      completedAt: now,
      configuredWallets: 0,
      eligibleWallets: 0,
      results: [],
    } satisfies AutonomousMonitorResult;
  }

  try {
    const result = await runAutonomousPerpsMonitor();
    await redis.set(LAST_RUN_KEY, JSON.stringify(result));
    return result;
  } finally {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [MONITOR_LOCK_KEY], arguments: [lockToken] }
    ).catch(() => undefined);
  }
}

export async function getLastAutonomousMonitorRun() {
  const redis = await getRedisClient();
  if (!redis) return null;
  const raw = await redis.get(LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AutonomousMonitorResult;
  } catch {
    return null;
  }
}
