import crypto from "node:crypto";

import { getPerpsRuntimeOverride } from "@/lib/perps/auditLog";
import {
  getActivePerpsAsset,
  isPerpsAutomationEnabled,
  type PerpsAutomationConfig,
} from "@/lib/perps/automationConfig";
import { disablePerpsScalpMode, listPerpsAutomationConfigs } from "@/lib/perps/automationConfigStore";
import { assertAgentWalletSigner, getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import {
  calculatePerpsPositionRoePercent,
  evaluatePerpsProfitLock,
  PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT,
  type PerpsProfitLockState,
} from "@/lib/perps/profitLock";
import { getPerpsSessionConfig, isPerpsLiveWalletAllowed } from "@/lib/perps/sessionConfig";
import { listPerpsSessions } from "@/lib/perps/sessionStore";
import type { PerpsAutomationSession } from "@/lib/perps/sessionTypes";
import { signSerializedPerpsTransaction } from "@/lib/perps/signer";
import { routePerpsSignalForUser } from "@/lib/perps/tradingAgent";
import { listUserPerpsExecutions, reconcileUserExecutionsWithoutOpenPosition } from "@/lib/perps/userExecutionAudit";
import { getWalletUsdcBalance } from "@/lib/perps/walletBalance";
import { fetchJupiterPerpsAccountSnapshot, type JupiterPerpsPosition } from "@/lib/jupiterPerps";
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
import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  detectAdaptiveScalpSignal,
  getScalpLearningProfile,
  type ScalpSignal,
} from "@/lib/perps/scalpEngine";

const MONITOR_LOCK_KEY = "brembot:perps:automation:monitor-lock";
const LAST_SIGNAL_KEY = "brembot:perps:automation:last-signal";
const LAST_RUN_KEY = "brembot:perps:automation:last-run";
const PROFIT_LOCK_STATE_KEY = "brembot:perps:automation:profit-lock";
const MONITOR_LOCK_TTL_MS = 55_000;
const MIN_PERPS_COLLATERAL_USD = 10;
const LOW_BALANCE_TRADE_USD = 12;
const LOW_BALANCE_TRADE_MAX_USDC = 50;
const MIN_TPSL_EXPECTED_PNL_USD = 1;
const ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE = 0.0012;
export const SCALP_SIGNAL_COOLDOWN_SECONDS = 25 * 60;

type AutonomousSignal = Omit<Signal, "type"> & {
  type: Signal["type"] | "scalp";
  setupType?: ScalpSignal["setupType"];
  priceActionScore?: number;
  priceActionTags?: string[];
  indicatorBypass?: boolean;
};
type StrategyClass = "smart" | "scalp";

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
  closePosition: (walletAddress: string, position: JupiterPerpsPosition) => Promise<{ txid: string }>;
  readProfitLockState: (walletAddress: string) => Promise<PerpsProfitLockState | null>;
  writeProfitLockState: (walletAddress: string, state: PerpsProfitLockState) => Promise<void>;
  clearProfitLockState: (walletAddress: string) => Promise<void>;
  readLastSignal: (walletAddress: string, asset: string, strategyClass: StrategyClass) => Promise<number | null>;
  writeLastSignal: (walletAddress: string, asset: string, strategyClass: StrategyClass, timestamp: number) => Promise<void>;
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
  closePosition: async (walletAddress, position) => {
    assertAgentWalletSigner(walletAddress);
    if (!position.accountRef) throw new Error("The live Jupiter position is missing its close reference.");
    const receiveToken = position.collateralSymbol === "BTC"
      || position.collateralSymbol === "ETH"
      || position.collateralSymbol === "SOL"
      ? position.collateralSymbol
      : "USDC";
    const {
      buildPerpsCloseTransaction,
      executeSignedPerpsTransaction,
    } = await import("@/lib/perps/jupiterAdapter");
    const built = await buildPerpsCloseTransaction(position.accountRef, receiveToken, "100");
    const signed = signSerializedPerpsTransaction(built.serializedTxBase64);
    const submitted = await executeSignedPerpsTransaction("decrease-position", signed.signedSerializedTxBase64);
    const txid = submitted.txid?.trim();
    if (!txid) throw new Error("Jupiter did not return a profit-lock close transaction signature.");
    return { txid };
  },
  readProfitLockState: async (walletAddress) => {
    const redis = await getRedisClient();
    if (!redis) return null;
    const raw = await redis.hGet(PROFIT_LOCK_STATE_KEY, walletAddress);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PerpsProfitLockState;
    } catch {
      return null;
    }
  },
  writeProfitLockState: async (walletAddress, state) => {
    const redis = await getRedisClient();
    if (!redis) throw new Error("Redis is unavailable while saving the Perps profit lock.");
    await redis.hSet(PROFIT_LOCK_STATE_KEY, walletAddress, JSON.stringify(state));
  },
  clearProfitLockState: async (walletAddress) => {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.hDel(PROFIT_LOCK_STATE_KEY, walletAddress);
  },
  readLastSignal: async (walletAddress, asset, strategyClass) => {
    const redis = await getRedisClient();
    if (!redis) return null;
    const cursorKey = strategyClass === "scalp"
      ? `${walletAddress}:${asset}:scalp`
      : `${walletAddress}:${asset}`;
    const value = await redis.hGet(LAST_SIGNAL_KEY, cursorKey);
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  },
  writeLastSignal: async (walletAddress, asset, strategyClass, timestamp) => {
    const redis = await getRedisClient();
    if (!redis) throw new Error("Redis is unavailable while saving the autonomous signal cursor.");
    const cursorKey = strategyClass === "scalp"
      ? `${walletAddress}:${asset}:scalp`
      : `${walletAddress}:${asset}`;
    await redis.hSet(LAST_SIGNAL_KEY, cursorKey, String(timestamp));
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
  return detectAdaptiveScalpSignal({
    symbol: options.symbol,
    points: options.points,
    indicators: options.indicators,
    profile: {
      ...structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
      cooldownSeconds: options.cooldownSeconds,
    },
    lastSignalAt: options.lastSignalAt,
  });
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

export function resolveAutonomousCollateralUsd(availableUsdc: number, collateralPercent: number) {
  const configuredCollateralUsd = Number((availableUsdc * collateralPercent / 100).toFixed(6));
  if (availableUsdc < LOW_BALANCE_TRADE_USD) {
    return Math.min(configuredCollateralUsd, MIN_PERPS_COLLATERAL_USD - 0.000001);
  }
  if (availableUsdc >= LOW_BALANCE_TRADE_USD && availableUsdc < LOW_BALANCE_TRADE_MAX_USDC) {
    return LOW_BALANCE_TRADE_USD;
  }
  return configuredCollateralUsd;
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

export function getScalpTradePlanningConfig(config: PerpsAutomationConfig): PerpsAutomationConfig {
  return {
    ...config,
    settings: {
      ...config.settings,
      perpsExecutionMode: "set-parameters",
      walletAllocationMode: "percent",
      walletPercent: 50,
    },
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
    ? (positionSizeUsd > 0
      ? (Math.max(1, options.takeProfitUsd) + positionSizeUsd * ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE) / positionSizeUsd
      : 0)
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
      const [snapshot, availableUsdc] = await Promise.all([
        deps.fetchSnapshot(agentWallet),
        deps.getUsdcBalance(agentWallet),
      ]);
      const openPositions = snapshot.positions.filter((position) => position.source !== "mock");
      if (openPositions.length > 0) {
        const position = openPositions[0]!;
        const positionPubkey = position.accountRef;
        const currentRoePercent = calculatePerpsPositionRoePercent(position);
        if (!positionPubkey || currentRoePercent === null) {
          results.push(skip(
            config,
            asset,
            "POSITION_PROFIT_LOCK_UNAVAILABLE",
            "An agent-owned position is open, but Jupiter has not returned the live position reference and collateral ROE needed for its profit lock."
          ));
          continue;
        }

        const previousState = await deps.readProfitLockState(config.walletAddress);
        const profitLock = evaluatePerpsProfitLock({
          positionPubkey,
          currentRoePercent,
          previousState,
        });
        await deps.writeProfitLockState(config.walletAddress, profitLock.state);

        if (profitLock.action === "close") {
          const closed = await deps.closePosition(config.walletAddress, position);
          await deps.writeProfitLockState(config.walletAddress, {
            ...profitLock.state,
            closeTxid: closed.txid,
            closeSubmittedAt: Date.now(),
            updatedAt: Date.now(),
          });
          results.push({
            walletAddress: config.walletAddress,
            asset,
            status: "executed",
            code: "PROFIT_LOCK_CLOSE_SUBMITTED",
            message: `Profit lock closed the position after ROE retreated to ${currentRoePercent.toFixed(2)}% from a ${profitLock.state.peakRoePercent.toFixed(2)}% peak. Close transaction: ${closed.txid}.`,
          });
          continue;
        }

        if (profitLock.action === "close-pending") {
          results.push(skip(
            config,
            asset,
            "PROFIT_LOCK_CLOSE_PENDING",
            `A profit-lock close is already pending for this position after its ${profitLock.state.peakRoePercent.toFixed(2)}% peak.`
          ));
          continue;
        }

        results.push(skip(
          config,
          asset,
          profitLock.action === "armed" ? "POSITION_PROFIT_LOCK_ARMED" : "POSITION_ALREADY_OPEN",
          profitLock.action === "armed"
            ? `Profit lock is armed at a ${profitLock.state.peakRoePercent.toFixed(2)}% peak and will close if live ROE reaches ${profitLock.exitRoePercent}% or lower.`
            : `An agent-owned Perps position is already open at ${currentRoePercent.toFixed(2)}% ROE. The first profit lock arms at ${PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT}%.`
        ));
        continue;
      }
      await deps.clearProfitLockState(config.walletAddress);
      await deps.reconcileLearningHistory(config.walletAddress, snapshot).catch(() => 0);
      if (config.settings.perpsExecutionMode === "smart-trades" && config.settings.decisionMode === "active") {
        // This initializes/migrates the researched baseline, immediately consumes newly closed
        // outcomes, and performs the trainer's interval-gated full holdout pass when due.
        await deps.autoTrain(config.walletAddress, config).catch(() => undefined);
      }
      const learningProfile = await deps.getLearningProfile(config.walletAddress);
      const executionProfile = config.settings.perpsExecutionMode === "smart-trades"
        && config.settings.decisionMode === "active"
        ? learningProfile
        : null;
      const effectiveParams = getLearnedSignalParams(config, asset, executionProfile);
      const points = await deps.fetchCandles(`${asset}-USD`, Math.max(60, effectiveParams.trendWindow + 35));
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
      const [lastSmartSignalAt, lastScalpSignalAt] = await Promise.all([
        deps.readLastSignal(config.walletAddress, asset, "smart"),
        deps.readLastSignal(config.walletAddress, asset, "scalp"),
      ]);
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
        lastSignalAt: lastSmartSignalAt ?? undefined,
      })[0];
      const indicatorSettings = getIndicatorSettings(learningProfile);
      const indicators = computeIndicatorSnapshot(points, indicatorSettings);
      const indicatorsReady = indicators.emaFast !== null
        && indicators.emaSlow !== null
        && indicators.rsi !== null
        && indicators.macdHistogram !== null
        && indicators.adx !== null;
      const smartIndicatorScore = smartSignal
        ? scoreIndicatorSnapshot(indicators, smartSignal.direction, indicatorSettings)
        : null;
      const breakoutMetric = Math.abs(signalMetrics.breakoutChange) >= effectiveParams.breakoutPercent
        ? signalMetrics.breakoutChange
        : signalMetrics.shortMomentum;
      const trendDirection = signalMetrics.trend.changePercent >= 0 ? "bullish" : "bearish";
      const breakoutDirection = breakoutMetric >= 0 ? "bullish" : "bearish";
      const smartLearningConfirmed = !smartSignal || !executionProfile || (
        Math.abs(signalMetrics.trend.changePercent) >= effectiveParams.trendThreshold
        && Math.abs(breakoutMetric) >= effectiveParams.breakoutPercent * 0.6
        && trendDirection === breakoutDirection
        && smartSignal.direction === trendDirection
      );
      const smartDirectionAllowed = !smartSignal
        || !executionProfile
        || executionProfile.preferredDirection === "balanced"
        || smartSignal.direction === executionProfile.preferredDirection;
      const smartEligible = Boolean(
        smartSignal
        && (!indicatorsReady || smartIndicatorScore?.qualified)
        && smartLearningConfirmed
        && smartDirectionAllowed
      );
      const scalpProfile = getScalpLearningProfile(learningProfile);
      const scalpSignal = config.settings.scalpModeEnabled
        ? detectAdaptiveScalpSignal({
            symbol: `${asset}/USD`,
            points: windowPoints,
            indicators,
            profile: scalpProfile,
            lastSignalAt: lastScalpSignalAt,
          })
        : null;
      const signal = smartEligible ? smartSignal! : scalpSignal;
      const strategyClass = smartEligible ? "smart" as const : "scalp" as const;
      if (!signal) {
        if (smartSignal && !smartEligible) {
          await deps.writeLastSignal(config.walletAddress, asset, "smart", smartSignal.timestamp);
        }
        const smartRejectedByIndicators = smartSignal && indicatorsReady && !smartIndicatorScore?.qualified;
        const smartRejectedByDirection = smartSignal && !smartDirectionAllowed;
        const smartRejectedByLearning = smartSignal && !smartLearningConfirmed;
        results.push(skip(
          config,
          asset,
          smartRejectedByIndicators
            ? smartIndicatorScore?.vetoed ? "INDICATOR_RSI_VETO" : "INDICATOR_CONFIRMATION_SKIP"
            : smartRejectedByDirection ? "LEARNED_DIRECTION_SKIP"
              : smartRejectedByLearning ? "LEARNED_CONFIRMATION_SKIP"
                : smartSignalCandidate ? "SMART_SIGNAL_COOLDOWN" : "NO_SIGNAL",
          smartRejectedByIndicators
            ? smartIndicatorScore?.vetoed
              ? `The ${smartSignal.direction} Smart candidate was skipped by the RSI extreme veto, and no qualifying scalp/reversal setup replaced it.`
              : `The Smart candidate scored ${smartIndicatorScore?.score.toFixed(1)} indicator points, and no qualifying scalp/reversal setup replaced it.`
            : smartRejectedByDirection
              ? `The Smart candidate opposed the trained Smart direction, and no qualifying independent scalp/reversal setup replaced it.`
              : smartRejectedByLearning
                ? "The Smart candidate lacked matching trend and breakout confirmation, and no qualifying independent scalp/reversal setup replaced it."
                : smartSignalCandidate
                  ? "A Smart candidate was in cooldown; Scalp Mode remains enabled, but no qualifying independent scalp/reversal setup was detected."
            : config.settings.scalpModeEnabled
              ? "No qualifying Smart, range scalp, or candle-structure reversal signal was detected in the latest window."
              : "No qualifying signal was detected in the latest candle window."
        ));
        continue;
      }
      const scalpMetadata = strategyClass === "scalp" ? signal as ScalpSignal : null;
      if (strategyClass === "smart" && executionProfile && volatilityPercent > executionProfile.volatilityCeilingPercent) {
        results.push(skip(config, asset, "LEARNED_VOLATILITY_SKIP", `Current ${volatilityPercent.toFixed(2)}% volatility exceeds the trained ${executionProfile.volatilityCeilingPercent.toFixed(2)}% ceiling.`));
        continue;
      }
      const indicatorScore = strategyClass === "scalp"
        ? {
            score: Number((signal.confidence * 5).toFixed(2)),
            qualified: true,
            vetoed: false,
            tags: scalpMetadata?.priceActionTags ?? ["SCALP_RANGE", signal.direction === "bullish" ? "SCALP_RANGE_LOW" : "SCALP_RANGE_HIGH"],
          }
        : smartIndicatorScore!;
      if (config.settings.mode === "buy-only" && signal.direction === "bearish") {
        await deps.writeLastSignal(config.walletAddress, asset, strategyClass, signal.timestamp);
        results.push(skip(config, asset, "BUY_ONLY_SKIP", "Buy-only mode skipped the bearish Perps signal."));
        continue;
      }
      const planningConfig = strategyClass === "scalp"
        ? getScalpTradePlanningConfig(config)
        : config;
      const basePlan = deriveTradePlan(planningConfig, windowPoints, signal, availableUsdc);
      const learnedPlan = applyLearnedTradePlan({
        basePlan,
        asset,
        points: windowPoints,
        profile: strategyClass === "smart" ? executionProfile : null,
        signalConfidence: signal.confidence,
        indicatorScore: indicatorScore.score,
        adx: indicators.adx,
        volumeRatio: indicators.volumeRatio,
      });
      const plan = strategyClass === "scalp"
        ? {
            ...learnedPlan,
            collateralPercent: Number((learnedPlan.collateralPercent * scalpProfile.riskMultiplier).toFixed(2)),
            leverage: Number((learnedPlan.leverage * Math.max(0.65, scalpProfile.riskMultiplier)).toFixed(2)),
            profileId: learningProfile?.profileId ?? null,
          }
        : learnedPlan;
      const collateralUsd = resolveAutonomousCollateralUsd(availableUsdc, plan.collateralPercent);
      if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) {
        results.push(skip(config, asset, "NO_COLLATERAL", "The configured allocation produced no usable USDC collateral."));
        continue;
      }
      if (collateralUsd < MIN_PERPS_COLLATERAL_USD) {
        await deps.writeLastSignal(config.walletAddress, asset, strategyClass, signal.timestamp);
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
          cooldownSeconds: strategyClass === "scalp"
            ? scalpProfile.cooldownSeconds
            : effectiveParams.cooldownSeconds,
          trendStrengthPercent: signalMetrics.trend.changePercent,
          breakoutStrengthPercent: signalMetrics.breakoutChange,
          atrPercent: plan.atrPercent,
          indicatorScore: indicatorScore.score,
          indicatorQualified: indicatorsReady ? indicatorScore.qualified : false,
          indicatorTags: indicatorsReady ? indicatorScore.tags : ["INDICATOR_HISTORY_INCOMPLETE"],
          scalpSetupType: scalpMetadata?.setupType,
          priceActionScore: scalpMetadata?.priceActionScore,
          priceActionTags: scalpMetadata?.priceActionTags,
          indicatorBypass: scalpMetadata?.indicatorBypass,
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
      await deps.writeLastSignal(config.walletAddress, asset, strategyClass, signal.timestamp);
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
