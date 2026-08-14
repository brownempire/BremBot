import assert from "node:assert/strict";
import test from "node:test";

import type { PerpsAutomationConfig } from "../lib/perps/automationConfig";
import { computeTriggerPrices, detectScalpSignal, getScalpTradePlanningConfig, resolveAutonomousCollateralUsd, runAutonomousPerpsMonitor, SCALP_SIGNAL_COOLDOWN_SECONDS } from "../lib/perps/autonomousMonitor";
import { SCALP_STOP_LOSS_ROE_PERCENT } from "../lib/perps/scalpExit";
import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  SCALP_EXCEPTIONAL_REVERSAL_SCORE,
  SCALP_PROFIT_COOLDOWN_SECONDS,
  SCALP_REVERSAL_MAX_ADX,
  SCALP_TRADE_LEVERAGE,
  analyzeScalpPriceAction,
  detectAdaptiveScalpSignal,
} from "../lib/perps/scalpEngine";
import type { DecisionLearningProfile } from "../lib/decision/learningTypes";
import type { JupiterPerpsPosition } from "../lib/jupiterPerps";
import {
  calculatePerpsPositionRoePercent,
  evaluatePerpsProfitLock,
  PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT,
  PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT,
  PROFIT_LOCK_ARM_ROE_PERCENT,
  PROFIT_LOCK_EXIT_ROE_PERCENT,
  SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT,
  type PerpsProfitLockState,
} from "../lib/perps/profitLock";
import type { PerpsAgentSignal, PerpsAutomationSession } from "../lib/perps/sessionTypes";

type RouteSignal = typeof import("../lib/perps/tradingAgent").routePerpsSignalForUser;

const walletAddress = "owner-wallet";

function createConfig(overrides: Partial<PerpsAutomationConfig> = {}): PerpsAutomationConfig {
  return {
    walletAddress,
    revision: 1,
    settings: {
      walletPercent: 25,
      walletAllocationMode: "percent",
      perpsTakeProfitValue: 2,
      perpsTakeProfitMode: "percent",
      spotTakeProfitValue: 0,
      spotTakeProfitMode: "percent",
      stopLossPercent: 1,
      perpsLeverage: 2,
      perpsExecutionMode: "set-parameters",
      scalpModeEnabled: false,
      scalpTakeProfitRoePercent: 25,
      decisionMode: "active",
      smartTradeProfile: "balanced",
      slots: [
        { id: "slot-sol", token: "SOL" },
        { id: "slot-eth", token: "ETH" },
        { id: "slot-btc", token: "BTC" },
      ],
      activeSlotId: null,
      perpsActiveSlotId: "slot-sol",
      mode: "all",
      disableTpLock: false,
    },
    params: {
      trendWindow: 5,
      trendThreshold: 0.5,
      breakoutPercent: 0.8,
      cooldownSeconds: 60,
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("scalp detection only creates a range-edge signal in a sideways market", () => {
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.1, 100.05, 99.95, 99.9].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const signal = detectScalpSignal({
    symbol: "SOL/USD",
    points,
    cooldownSeconds: 180,
    indicators: {
      emaFast: 99.98,
      emaSlow: 100,
      emaSpreadPercent: -0.02,
      emaSlopePercent: -0.01,
      rsi: 39,
      macdLine: -0.01,
      macdSignal: -0.01,
      macdHistogram: 0,
      macdHistogramChange: 0,
      adx: 14,
      plusDi: 18,
      minusDi: 20,
      atrPercent: 0.08,
      volumeRatio: 1.1,
      bollingerBandwidthPercent: 0.6,
      bollingerPosition: -0.2,
    },
  });

  assert.equal(signal?.type, "scalp");
  assert.equal(signal?.direction, "bullish");
});

test("scalp detection uses an independent 42.5-minute cooldown", () => {
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.1, 100.05, 99.95, 99.9].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const indicators = {
    emaFast: 99.98,
    emaSlow: 100,
    emaSpreadPercent: -0.02,
    emaSlopePercent: -0.01,
    rsi: 39,
    macdLine: -0.01,
    macdSignal: -0.01,
    macdHistogram: 0,
    macdHistogramChange: 0,
    adx: 14,
    plusDi: 18,
    minusDi: 20,
    atrPercent: 0.08,
    volumeRatio: 1.1,
    bollingerBandwidthPercent: 0.6,
    bollingerPosition: -0.2,
  };
  const latestTimestamp = points[points.length - 1]!.t;

  assert.equal(SCALP_SIGNAL_COOLDOWN_SECONDS, 2_550);
  assert.equal(detectScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators,
    cooldownSeconds: SCALP_SIGNAL_COOLDOWN_SECONDS,
    lastSignalAt: latestTimestamp - (SCALP_SIGNAL_COOLDOWN_SECONDS * 1_000 - 1),
  }), null);
  assert.equal(detectScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators,
    cooldownSeconds: SCALP_SIGNAL_COOLDOWN_SECONDS,
    lastSignalAt: latestTimestamp - SCALP_SIGNAL_COOLDOWN_SECONDS * 1_000,
  })?.type, "scalp");
});

function reversalIndicators(overrides: Record<string, number | null> = {}) {
  return {
    emaFast: 100.4,
    emaSlow: 99.5,
    emaSpreadPercent: 0.9,
    emaSlopePercent: 0.2,
    rsi: 58,
    macdLine: -0.01,
    macdSignal: 0,
    macdHistogram: -0.01,
    macdHistogramChange: 0.01,
    adx: 38,
    plusDi: 18,
    minusDi: 24,
    atrPercent: 0.12,
    volumeRatio: 1.6,
    bollingerBandwidthPercent: 0.8,
    bollingerPosition: 0.55,
    ...overrides,
  };
}

function bullishSweepPoints() {
  const baseTime = 1_784_174_800_000;
  return Array.from({ length: 24 }, (_, index) => {
    const closes = [100, 99.98, 99.82, 99.88, 100.02, 100.16];
    const close = index < 18 ? 100 + Math.sin(index) * 0.015 : closes[index - 18]!;
    return {
      t: baseTime + index * 60_000,
      o: index === 20 ? 100 : close - 0.01,
      h: index === 20 ? 100.02 : close + 0.03,
      l: index === 20 ? 99.7 : close - 0.03,
      v: close,
      volume: index >= 22 ? 220 : 100,
    };
  });
}

function exceptionalBullishSweepPoints() {
  return bullishSweepPoints().map((point, index) => index === 22
    ? {
        ...point,
        o: 99.98,
        h: 100.04,
        l: 99.8,
      }
    : point);
}

test("exceptional confirmed liquidity-sweep reversal can bypass the trend-strength ceiling", () => {
  const points = exceptionalBullishSweepPoints();
  const priceAction = analyzeScalpPriceAction(points, DEFAULT_SCALP_LEARNING_PROFILE);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX + 20 }),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
  });

  assert.equal(priceAction.direction, "bullish");
  assert.equal(priceAction.setupType, "liquidity-sweep");
  assert.equal(priceAction.strong, true);
  assert.equal(priceAction.confirmed, true);
  assert.ok(priceAction.score >= SCALP_EXCEPTIONAL_REVERSAL_SCORE);
  assert.equal(signal?.direction, "bullish");
  assert.equal(signal?.indicatorBypass, true);
  assert.ok(signal?.priceActionTags.includes("PRICE_LIQUIDITY_SWEEP_RECLAIM"));
  assert.ok(signal?.priceActionTags.includes("EXCEPTIONAL_CONFIRMED_PRICE_ACTION"));
});

test("the candle-structure reversal detector handles bearish liquidity sweeps symmetrically", () => {
  const points = exceptionalBullishSweepPoints().map((point) => ({
    ...point,
    v: 200 - point.v,
    o: 200 - point.o,
    h: 200 - point.l,
    l: 200 - point.h,
  }));
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({
      emaFast: 99.4,
      emaSlow: 100.3,
      emaSpreadPercent: -0.9,
      emaSlopePercent: -0.2,
      rsi: 42,
      plusDi: 24,
      minusDi: 18,
    }),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
  });

  assert.equal(signal?.direction, "bearish");
  assert.equal(signal?.setupType, "liquidity-sweep");
  assert.equal(signal?.indicatorBypass, true);
});

test("a lone price spike without reclaim and momentum confirmation cannot bypass indicators", () => {
  const points = bullishSweepPoints().map((point, index) => index >= 21
    ? { ...point, v: 99.74, o: 99.76, h: 99.79, l: 99.7, volume: 100 }
    : point);
  const priceAction = analyzeScalpPriceAction(points, DEFAULT_SCALP_LEARNING_PROFILE);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators(),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
  });

  assert.equal(priceAction.direction, null);
  assert.equal(signal, null);
});

test("ADX above 40 still rejects a non-exceptional confirmed reversal", () => {
  const points = bullishSweepPoints();
  const profile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  const priceAction = analyzeScalpPriceAction(points, profile);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX + 0.01 }),
    profile,
  });

  assert.equal(priceAction.strong, false);
  assert.equal(priceAction.confirmed, true);
  assert.ok(priceAction.score < SCALP_EXCEPTIONAL_REVERSAL_SCORE);
  assert.equal(signal, null);
});

test("a confirmed reversal at the ADX 40 ceiling remains eligible", () => {
  const profile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points: bullishSweepPoints(),
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX }),
    profile,
  });

  assert.equal(signal?.setupType, "liquidity-sweep");
  assert.equal(signal?.indicatorBypass, false);
});

test("a profitable scalp permits an exceptional opposite reversal five minutes after closing", () => {
  const points = exceptionalBullishSweepPoints();
  const latestTimestamp = points.at(-1)!.t;
  const lastSignalAt = latestTimestamp - 12 * 60_000;
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX + 20 }),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
    lastSignalAt,
    recentClosedTrade: {
      openedAt: lastSignalAt + 30_000,
      closedAt: latestTimestamp - SCALP_PROFIT_COOLDOWN_SECONDS * 1_000,
      side: "short",
      netPnlUsd: 3.5,
    },
  });

  assert.equal(SCALP_PROFIT_COOLDOWN_SECONDS, 300);
  assert.equal(signal?.direction, "bullish");
  assert.equal(signal?.indicatorBypass, true);
});

test("the shortened cooldown does not apply to losses, same-direction entries, or early reversals", () => {
  const points = exceptionalBullishSweepPoints();
  const latestTimestamp = points.at(-1)!.t;
  const lastSignalAt = latestTimestamp - 12 * 60_000;
  const detect = (side: "long" | "short", netPnlUsd: number, closedMinutesAgo: number) => detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators({ adx: SCALP_REVERSAL_MAX_ADX + 20 }),
    profile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
    lastSignalAt,
    recentClosedTrade: {
      openedAt: lastSignalAt,
      closedAt: latestTimestamp - closedMinutesAgo * 60_000,
      side,
      netPnlUsd,
    },
  });

  assert.equal(detect("short", -1, 6), null);
  assert.equal(detect("long", 3.5, 6), null);
  assert.equal(detect("short", 3.5, 4), null);
});

test("raw scalp confidence must clear the learned threshold instead of being raised to it", () => {
  const points = bullishSweepPoints();
  const profile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  profile.minimumConfidence = 0.82;
  profile.setupConfidenceAdjustments.liquiditySweep = 0.08;
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: reversalIndicators(),
    profile,
  });

  assert.equal(signal, null);
});

test("scalp trigger pricing adds estimated fees to the adaptive net target", () => {
  const config = createConfig();
  const triggers = computeTriggerPrices({
    config,
    entryPrice: 100,
    collateralUsd: 25,
    leverage: 2,
    side: "long",
    stopLossPercent: 0,
    takeProfitPercent: 0,
    takeProfitUsd: 5,
  });
  const targetPnl = (((triggers.takeProfitPrice ?? 0) - 100) / 100) * 50;

  assert.ok(targetPnl - 50 * 0.0012 >= 4.999999);
  assert.equal(triggers.stopLossPrice, null);
});

test("scalp planning uses 50 percent wallet allocation and 50x leverage", () => {
  const planningConfig = getScalpTradePlanningConfig(createConfig());
  assert.equal(planningConfig.settings.walletAllocationMode, "percent");
  assert.equal(planningConfig.settings.walletPercent, 50);
  assert.equal(planningConfig.settings.perpsLeverage, SCALP_TRADE_LEVERAGE);
  assert.equal(planningConfig.settings.stopLossPercent, SCALP_STOP_LOSS_ROE_PERCENT);
  assert.equal(SCALP_TRADE_LEVERAGE, 50);
  assert.equal(planningConfig.settings.perpsExecutionMode, "set-parameters");
});

test("low-balance collateral uses exactly $12 from $12 up to but not including $50", () => {
  assert.equal(resolveAutonomousCollateralUsd(11.99, 20), 2.398);
  assert.equal(resolveAutonomousCollateralUsd(11.99, 100), 9.999999);
  assert.equal(resolveAutonomousCollateralUsd(12, 20), 12);
  assert.equal(resolveAutonomousCollateralUsd(25, 20), 12);
  assert.equal(resolveAutonomousCollateralUsd(49.99, 20), 12);
  assert.equal(resolveAutonomousCollateralUsd(50, 20), 10);
});

test("monitor combines the profitable cooldown exception with 50x protected scalp execution", async () => {
  const points = exceptionalBullishSweepPoints();
  const latestTimestamp = points.at(-1)!.t;
  const lastSignalAt = latestTimestamp - 12 * 60_000;
  let routedSignal: PerpsAgentSignal | null = null;
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      perpsLeverage: 10,
      scalpModeEnabled: true,
      stopLossPercent: 25,
    },
    params: {
      ...base.params,
      trendWindow: 24,
    },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLatestClosedScalpOutcome: async () => ({
      openedAt: new Date(lastSignalAt + 30_000).toISOString(),
      closedAt: new Date(latestTimestamp - SCALP_PROFIT_COOLDOWN_SECONDS * 1_000).toISOString(),
      side: "short",
      netPnlUsd: 3.5,
    }) as never,
    readLastSignal: async (_wallet, _asset, strategyClass) => strategyClass === "scalp" ? lastSignalAt : null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.equal(routed?.strategyClass, "scalp");
  assert.equal(routed?.leverage, SCALP_TRADE_LEVERAGE);
  assert.equal(routed?.collateralUsd, 25);
  assert.ok((routed?.takeProfitPrice ?? 0) > (routed?.marketContext?.spotPrice ?? Number.POSITIVE_INFINITY));
  assert.ok((routed?.stopLossPrice ?? Number.POSITIVE_INFINITY) < (routed?.marketContext?.spotPrice ?? 0));
  const entryPrice = routed?.marketContext?.spotPrice ?? 0;
  const takeProfitRoe = entryPrice > 0
    ? (((routed?.takeProfitPrice ?? 0) - entryPrice) / entryPrice) * SCALP_TRADE_LEVERAGE * 100
    : 0;
  const stopLossRoe = entryPrice > 0
    ? ((entryPrice - (routed?.stopLossPrice ?? entryPrice)) / entryPrice) * SCALP_TRADE_LEVERAGE * 100
    : 0;
  assert.ok(takeProfitRoe >= 42.24);
  assert.ok(takeProfitRoe <= 100.01);
  assert.ok(Math.abs(stopLossRoe - SCALP_STOP_LOSS_ROE_PERCENT) < 0.01);
});

test("three-trade scalp experiment executes the exact opposite direction and counts only submissions", async () => {
  const points = exceptionalBullishSweepPoints();
  let routedSignal: PerpsAgentSignal | null = null;
  let recordedTrades = 0;
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
    getDirectionExperiment: async () => ({
      experimentId: "inverse-test",
      baselineProfileId: "baseline-test",
      enabled: true,
      maxTrades: 3,
      tradesCompleted: 0,
      tradesRemaining: 3,
      startedAt: new Date().toISOString(),
      completedAt: null,
    }),
    recordDirectionExperimentTrade: async () => {
      recordedTrades += 1;
      return {
        experimentId: "inverse-test",
        baselineProfileId: "baseline-test",
        enabled: true,
        maxTrades: 3,
        tradesCompleted: 1,
        tradesRemaining: 2,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
    },
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  const entry = routed?.marketContext?.spotPrice ?? 0;
  assert.equal(routed?.strategyClass, "scalp");
  assert.equal(routed?.strategyContext?.detectedDirection, "bullish");
  assert.equal(routed?.direction, "bearish");
  assert.equal(routed?.strategyContext?.directionInverted, true);
  assert.equal(routed?.strategyContext?.directionExperimentId, "inverse-test");
  assert.equal(routed?.strategyContext?.directionExperimentTradeNumber, 1);
  assert.ok((routed?.takeProfitPrice ?? Number.POSITIVE_INFINITY) < entry);
  assert.ok((routed?.stopLossPrice ?? 0) > entry);
  assert.equal(recordedTrades, 1);
  assert.match(result.results[0]?.message ?? "", /1\/3 submitted, 2 remaining/);
});

test("opposite-direction experiment does not consume a trade when routing is rejected", async () => {
  const points = exceptionalBullishSweepPoints();
  let recordedTrades = 0;
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });

  await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: false, code: "NOT_EXECUTED", message: "rejected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
    getDirectionExperiment: async () => ({
      experimentId: "inverse-test",
      baselineProfileId: "baseline-test",
      enabled: true,
      maxTrades: 3,
      tradesCompleted: 0,
      tradesRemaining: 3,
      startedAt: new Date().toISOString(),
      completedAt: null,
    }),
    recordDirectionExperimentTrade: async () => {
      recordedTrades += 1;
      return null;
    },
  });

  assert.equal(recordedTrades, 0);
});

test("monitor pauses scalp entries while the winner-derived profile fails validation", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      scalpModeEnabled: true,
    },
    params: {
      ...base.params,
      trendWindow: 24,
    },
  });
  const profile = createLearningProfile();
  profile.scalpProfile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  profile.scalpProfile.validation = {
    ...profile.scalpProfile.validation,
    passed: false,
    reasons: ["Loss-history validation failed."],
  };
  let routeCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => profile,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "SCALP_VALIDATION_PAUSED");
  assert.match(result.results[0]?.message ?? "", /winner-derived profile/i);
});

test("a successfully taken smart trade turns Scalp Mode off after routing", async () => {
  let disabledWallet: string | null = null;
  let routedStrategy: PerpsAgentSignal["strategyClass"] = undefined;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedStrategy = signal.strategyClass;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async (address) => {
      disabledWallet = address;
      return null;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "executed");
  assert.equal(disabledWallet, walletAddress);
  assert.equal(routedStrategy, "smart");
});

test("an active opposite-direction experiment waits for scalp and suppresses Smart entries", async () => {
  let routeCalls = 0;
  let disableCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async () => {
      disableCalls += 1;
      return null;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
    getDirectionExperiment: async () => ({
      experimentId: "inverse-test",
      baselineProfileId: "baseline-test",
      enabled: true,
      maxTrades: 3,
      tradesCompleted: 0,
      tradesRemaining: 3,
      startedAt: new Date().toISOString(),
      completedAt: null,
    }),
  });

  assert.equal(result.results[0]?.code, "NO_SIGNAL");
  assert.match(result.results[0]?.message ?? "", /waiting for a qualifying scalp setup/i);
  assert.match(result.results[0]?.message ?? "", /0\/3 submitted, 3 remaining/);
  assert.equal(routeCalls, 0);
  assert.equal(disableCalls, 0);
});

test("a generated smart signal that is skipped leaves Scalp Mode enabled", async () => {
  let disableCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({
      ok: false,
      code: "DECISION_LAYER_SKIP",
      message: "The smart signal was skipped.",
    })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async () => {
      disableCalls += 1;
      return null;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "skipped");
  assert.equal(result.results[0]?.code, "DECISION_LAYER_SKIP");
  assert.equal(disableCalls, 0);
});

test("a smart candidate inside cooldown leaves Scalp Mode enabled", async () => {
  let disableCalls = 0;
  let routeCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, scalpModeEnabled: true } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    disableScalpMode: async () => {
      disableCalls += 1;
      return null;
    },
    readLastSignal: async () => points[points.length - 1]!.t,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.code, "SMART_SIGNAL_COOLDOWN");
  assert.match(result.results[0]?.message ?? "", /remains enabled/i);
  assert.equal(routeCalls, 0);
  assert.equal(disableCalls, 0);
});

function createSession(): PerpsAutomationSession {
  return {
    sessionId: "session-1",
    walletAddress,
    sessionState: "clocked_in",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    inactiveSince: null,
    endedAt: null,
    mode: "live",
    executionModel: "delegated-ready",
    appOpen: false,
    appForeground: false,
    walletConnected: false,
    walletWriteEnabled: true,
    killSwitch: false,
    unlimitedSession: true,
    platform: "web",
    walletProvider: "Agent wallet",
    warning: null,
  };
}

function createOpenPosition(
  roePercent: number,
  overrides: Partial<JupiterPerpsPosition> = {}
): JupiterPerpsPosition {
  return {
    id: "live-position-sol",
    source: "live-api",
    platformId: "jupiter-exchange",
    marketSymbol: "SOL",
    marketName: "Solana Perps",
    marketAddress: "market",
    custodyAddress: "custody",
    collateralCustodyAddress: "collateral-custody",
    collateralSymbol: "USDC",
    imageUri: null,
    side: "long",
    entryPrice: 100,
    markPrice: 102,
    positionSize: 2,
    positionValue: 204,
    collateralValue: 100,
    leverage: 2,
    unrealizedPnl: roePercent,
    realizedPnl: null,
    liquidationPrice: 60,
    fundingSnapshot: null,
    borrowSnapshot: null,
    takeProfit: 115,
    stopLoss: 90,
    markPriceIsLive: true,
    liquidationPriceIsEstimated: false,
    accountRef: "position-pubkey",
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function createLearningProfile(): DecisionLearningProfile {
  const now = new Date().toISOString();
  return {
    profileId: "profile-1",
    walletAddress,
    version: 1,
    status: "active",
    source: "operator-baseline",
    createdAt: now,
    promotedAt: now,
    learnedFromClosedTrades: 0,
    strategyBaselineVersion: 3,
    minimumConfidence: 0.62,
    leverageCap: 2,
    maximumAllocationPercent: 5,
    targetWalletRiskPercent: 1,
    preferredDirection: "balanced",
    trendWindow: 15,
    cooldownSeconds: 300,
    takeProfitRoePercent: 1,
    stopLossRoePercent: 1,
    minimumRewardRiskRatio: 2,
    atrLookback: 14,
    atrStopMultiplier: 1.5,
    volatilityCeilingPercent: 5,
    assetAdjustments: {
      SOL: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 0.5, allocationMultiplier: 0.5 },
      ETH: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 0.5, allocationMultiplier: 0.5 },
      BTC: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 0.5, allocationMultiplier: 0.5 },
    },
    validation: {
      sampleSize: 0,
      trainingSize: 0,
      validationSize: 0,
      winRate: 0,
      expectancyUsd: 0,
      profitFactor: 0,
      maxDrawdownUsd: 0,
      passed: true,
      reasons: ["test"],
    },
    summary: "Test profile",
  };
}

test("first profit-lock tier arms at 15% ROE and closes on a retreat to 10%", () => {
  assert.equal(PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT, 15);
  assert.equal(PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT, 10);

  const armed = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 15,
    previousState: null,
    now: 1_000,
  });
  assert.equal(armed.action, "armed");
  assert.equal(armed.activeTier, "fifteen-to-ten");
  assert.equal(armed.exitRoePercent, 10);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 10,
    previousState: armed.state,
    now: 2_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "fifteen-to-ten");
  assert.equal(retreat.state.peakRoePercent, 15);
});

test("scalp staircase arms at 10% ROE and closes on a retreat to 7%", () => {
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_ARM_ROE_PERCENT, 10);
  assert.equal(SCALP_PROFIT_LOCK_INITIAL_EXIT_ROE_PERCENT, 7);

  const armed = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 10,
    previousState: null,
    now: 1_000,
  });
  assert.equal(armed.action, "armed");
  assert.equal(armed.activeTier, "ten-to-seven");
  assert.equal(armed.exitRoePercent, 7);
  assert.equal(armed.state.strategyClass, "scalp");

  const held = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 8,
    previousState: armed.state,
    now: 2_000,
  });
  assert.equal(held.action, "armed");

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 7,
    previousState: held.state,
    now: 3_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "ten-to-seven");
});

test("Smart Trades retain the original staircase and do not arm at 10% ROE", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "smart-position",
    strategyClass: "smart",
    currentRoePercent: 10,
    previousState: null,
    now: 1_000,
  });
  assert.equal(evaluation.action, "track");
  assert.equal(evaluation.activeTier, null);
  assert.equal(evaluation.armRoePercent, 15);
});

test("a scalp position promotes from 10-to-7 through the existing upper tiers", () => {
  const first = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 11,
    previousState: null,
    now: 1_000,
  });
  assert.equal(first.activeTier, "ten-to-seven");

  const second = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 16,
    previousState: first.state,
    now: 2_000,
  });
  assert.equal(second.activeTier, "fifteen-to-ten");
  assert.equal(second.exitRoePercent, 10);

  const third = evaluatePerpsProfitLock({
    positionPubkey: "scalp-position",
    strategyClass: "scalp",
    currentRoePercent: 21,
    previousState: second.state,
    now: 3_000,
  });
  assert.equal(third.activeTier, "twenty-to-fifteen");
  assert.equal(third.exitRoePercent, 15);
});

test("a scalp runner protects gains near the raised post-fee TP", () => {
  const thirty = evaluatePerpsProfitLock({
    positionPubkey: "scalp-runner",
    strategyClass: "scalp",
    currentRoePercent: 30,
    previousState: null,
    now: 1_000,
  });
  assert.equal(thirty.activeTier, "thirty-to-twenty-three");
  assert.equal(thirty.exitRoePercent, 23);

  const forty = evaluatePerpsProfitLock({
    positionPubkey: "scalp-runner",
    strategyClass: "scalp",
    currentRoePercent: 40,
    previousState: thirty.state,
    now: 2_000,
  });
  assert.equal(forty.activeTier, "forty-to-thirty-two");
  assert.equal(forty.exitRoePercent, 32);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "scalp-runner",
    strategyClass: "scalp",
    currentRoePercent: 32,
    previousState: forty.state,
    now: 3_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "forty-to-thirty-two");
});

test("second profit-lock tier arms at 20% ROE and closes on a retreat to 15%", () => {
  assert.equal(PROFIT_LOCK_ARM_ROE_PERCENT, 20);
  assert.equal(PROFIT_LOCK_EXIT_ROE_PERCENT, 15);
  assert.equal(calculatePerpsPositionRoePercent(createOpenPosition(20)), 20);

  const armed = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 20,
    previousState: null,
    now: 1_000,
  });
  assert.equal(armed.action, "armed");
  assert.equal(armed.activeTier, "twenty-to-fifteen");
  assert.equal(armed.exitRoePercent, 15);
  assert.equal(armed.state.peakRoePercent, 20);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 15,
    previousState: armed.state,
    now: 2_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.state.peakRoePercent, 20);
});

test("profit lock does not close at 10% unless the same position first reached 15%", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 10,
    previousState: null,
    now: 1_000,
  });
  assert.equal(evaluation.action, "track");
  assert.equal(evaluation.state.armedAt, null);
});

test("a position promoted to the 20-to-15 tier cannot fall back to the 15-to-10 tier", () => {
  const firstTier = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 16,
    previousState: null,
    now: 1_000,
  });
  assert.equal(firstTier.activeTier, "fifteen-to-ten");

  const promoted = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 21,
    previousState: firstTier.state,
    now: 2_000,
  });
  assert.equal(promoted.activeTier, "twenty-to-fifteen");
  assert.equal(promoted.exitRoePercent, 15);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState: promoted.state,
    now: 3_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "twenty-to-fifteen");
  assert.equal(retreat.exitRoePercent, 15);
});

test("the tier thresholds arm a current position from its Redis-tracked peak", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 17,
    previousState: {
      positionPubkey: "position-pubkey",
      peakRoePercent: 21,
      armedAt: null,
      closeTxid: null,
      closeSubmittedAt: null,
      updatedAt: 1_000,
    },
    now: 2_000,
  });
  assert.equal(evaluation.action, "armed");
  assert.equal(evaluation.activeTier, "twenty-to-fifteen");
  assert.equal(evaluation.state.armedAt, 2_000);
  assert.equal(evaluation.state.peakRoePercent, 21);
});

test("the upper tier immediately closes a current position below 15% after a Redis-tracked 20% peak", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState: {
      positionPubkey: "position-pubkey",
      peakRoePercent: 21,
      armedAt: null,
      closeTxid: null,
      closeSubmittedAt: null,
      updatedAt: 1_000,
    },
    now: 2_000,
  });
  assert.equal(evaluation.action, "close");
  assert.equal(evaluation.state.armedAt, 2_000);
});

test("a submitted profit-lock close is not duplicated while it is pending", () => {
  const previousState: PerpsProfitLockState = {
    positionPubkey: "position-pubkey",
    peakRoePercent: 30,
    armedAt: 1_000,
    closeTxid: "close-tx",
    closeSubmittedAt: 2_000,
    updatedAt: 2_000,
  };
  assert.equal(evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState,
    now: 60_000,
  }).action, "close-pending");
  assert.equal(evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 14,
    previousState,
    now: 130_000,
  }).action, "close");
});

test("server monitor routes a qualifying signal while the app is closed", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  let savedCursor = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: null, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async (_wallet, _asset, strategyClass, timestamp) => {
      assert.equal(strategyClass, "smart");
      savedCursor = timestamp;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.status, "executed");
  assert.equal((routedSignal as PerpsAgentSignal | null)?.asset, "SOL");
  assert.equal((routedSignal as PerpsAgentSignal | null)?.collateralUsd, 25);
  assert.equal((routedSignal as PerpsAgentSignal | null)?.leverage, 2);
  const routedTakeProfit = (routedSignal as PerpsAgentSignal | null)?.takeProfitPrice ?? 0;
  const routedStopLoss = (routedSignal as PerpsAgentSignal | null)?.stopLossPrice ?? 0;
  const entryPrice = points[points.length - 1]?.v ?? 0;
  const positionSizeUsd = 25 * 2;
  assert.ok(((routedTakeProfit - entryPrice) / entryPrice) * positionSizeUsd >= 1);
  assert.ok(((entryPrice - routedStopLoss) / entryPrice) * positionSizeUsd >= 1);
  assert.equal(savedCursor, points[points.length - 1]?.t);
});

test("server monitor routes exactly $12 when available USDC is between $12 and $50", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 20,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.status, "executed");
  assert.equal((routedSignal as PerpsAgentSignal | null)?.collateralUsd, 12);
  assert.equal((routedSignal as PerpsAgentSignal | null)?.marketContext?.availableUsdc, 20);
});

test("smart monitoring applies adaptive leverage and real 25% TP / 25% SL", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      walletPercent: 80,
      perpsLeverage: 10,
      perpsExecutionMode: "smart-trades",
      smartTradeProfile: "aggressive",
    },
  });
  const legacyFixture = createLearningProfile();
  const profile: DecisionLearningProfile = {
    ...legacyFixture,
    strategyBaselineVersion: 3,
    minimumConfidence: 0.68,
    leverageFloor: 2,
    leverageCap: 20,
    leverageQualityExponent: 2.5,
    leverageVolatilityPenalty: 1.25,
    leverageLossStepdown: 1,
    maximumAllocationPercent: 50,
    targetWalletRiskPercent: 3,
    takeProfitRoePercent: 25,
    stopLossRoePercent: 15,
    assetAdjustments: {
      ...legacyFixture.assetAdjustments,
      SOL: { trendThreshold: 0.5, breakoutPercent: 0.3, leverageMultiplier: 1, allocationMultiplier: 1 },
    },
  };

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => profile,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.ok((routed?.leverage ?? 0) >= 2 && (routed?.leverage ?? 0) <= 20);
  assert.ok((routed?.collateralUsd ?? 0) <= 12);
  const entryPrice = points.at(-1)?.v ?? 0;
  const leverage = routed?.leverage ?? 1;
  assert.ok(Math.abs((((routed?.takeProfitPrice ?? 0) - entryPrice) / entryPrice) * leverage * 100 - 25) < 0.01);
  assert.ok(Math.abs(((entryPrice - (routed?.stopLossPrice ?? 0)) / entryPrice) * leverage * 100 - 25) < 0.01);
});

test("server monitor fails closed when an agent position is already open", async () => {
  let routeCalls = 0;
  let profitLockState: PerpsProfitLockState | null = null;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({ positions: [createOpenPosition(10)], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "POSITION_ALREADY_OPEN");
});

test("server monitor closes the first-tier profit lock at 10% even with pending TP and SL", async () => {
  let profitLockState: PerpsProfitLockState | null = null;
  let closeCalls = 0;
  const run = (roePercent: number) => runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: (async () => ({
      positions: [createOpenPosition(roePercent)],
      pendingTriggers: [
        { kind: "take-profit", positionPubkey: "position-pubkey" },
        { kind: "stop-loss", positionPubkey: "position-pubkey" },
      ],
      recentTrades: [],
    })) as never,
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "first-tier-profit-lock-close-tx" };
    },
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const armed = await run(16);
  assert.equal(armed.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.match(armed.results[0]?.message ?? "", /10% or lower/);
  assert.equal(closeCalls, 0);

  const held = await run(12);
  assert.equal(held.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.equal(closeCalls, 0);

  const closed = await run(10);
  assert.equal(closed.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.activeTier, "fifteen-to-ten");
});

test("server monitor applies the 10-to-7 staircase only to an open scalp position", async () => {
  let profitLockState: PerpsProfitLockState | null = null;
  let closeCalls = 0;
  const base = createConfig();
  const scalpConfig = createConfig({
    settings: {
      ...base.settings,
      scalpModeEnabled: true,
    },
  });
  const run = (roePercent: number) => runAutonomousPerpsMonitor({
    listConfigs: async () => [scalpConfig],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(roePercent)],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "scalp-staircase-close-tx" };
    },
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const armed = await run(11);
  assert.equal(armed.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.match(armed.results[0]?.message ?? "", /7% or lower/);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.strategyClass, "scalp");
  assert.equal((profitLockState as PerpsProfitLockState | null)?.activeTier, "ten-to-seven");

  const held = await run(8);
  assert.equal(held.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.equal(closeCalls, 0);

  const closed = await run(7);
  assert.equal(closed.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.closeTxid, "scalp-staircase-close-tx");
});

test("server monitor closes an armed profitable position at 15% even with pending TP and SL", async () => {
  let profitLockState: PerpsProfitLockState | null = null;
  let closeCalls = 0;
  const run = (roePercent: number) => runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: (async () => ({
      positions: [createOpenPosition(roePercent)],
      pendingTriggers: [
        { kind: "take-profit", positionPubkey: "position-pubkey" },
        { kind: "stop-loss", positionPubkey: "position-pubkey" },
      ],
      recentTrades: [],
    })) as never,
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    closePosition: async (_address, position) => {
      closeCalls += 1;
      assert.equal(position.accountRef, "position-pubkey");
      return { txid: "profit-lock-close-tx" };
    },
    readProfitLockState: async () => profitLockState,
    writeProfitLockState: async (_address, state) => {
      profitLockState = state;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const armed = await run(22);
  assert.equal(armed.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.match(armed.results[0]?.message ?? "", /15% or lower/);
  assert.equal(closeCalls, 0);

  const closed = await run(15);
  assert.equal(closed.results[0]?.status, "executed");
  assert.equal(closed.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal((profitLockState as PerpsProfitLockState | null)?.closeTxid, "profit-lock-close-tx");
});

test("server monitor clears stale profit-lock state after the position closes", async () => {
  let clearCalls = 0;
  await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => ({ ok: true, message: "unexpected" })) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    clearProfitLockState: async () => {
      clearCalls += 1;
    },
    getLearningProfile: async () => null,
    reconcileLearningHistory: async () => 0,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(clearCalls, 1);
});

test("set-parameter monitoring uses saved settings while still loading learning history", async () => {
  let routedSignal: PerpsAgentSignal | null = null;
  let learningLoads = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100, 99.95, 99.9, 99.8].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: {
      ...base.settings,
      walletPercent: 80,
      perpsLeverage: 50,
      perpsTakeProfitValue: 4,
      stopLossPercent: 2,
      perpsExecutionMode: "set-parameters",
    },
    params: {
      trendWindow: 15,
      trendThreshold: 0.1,
      breakoutPercent: 0.3,
      cooldownSeconds: 180,
    },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => {
      learningLoads += 1;
      return createLearningProfile();
    },
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.equal(learningLoads, 1);
  assert.equal(routed?.collateralUsd, 80);
  assert.equal(routed?.leverage, 50);
  assert.equal(routed?.strategyContext?.trendWindow, 15);
  assert.equal(routed?.strategyContext?.trendThreshold, 0.1);
  assert.equal(routed?.strategyContext?.cooldownSeconds, 180);
  assert.equal(routed?.strategyContext?.learningProfileId, null);
});

test("smart-trade monitoring retains learned confirmation controls", async () => {
  let routeCalls = 0;
  let autoTrainCalls = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100, 99.95, 99.9, 99.8].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, perpsExecutionMode: "smart-trades" },
    params: { ...base.params, trendThreshold: 0.1, breakoutPercent: 0.3 },
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => createLearningProfile(),
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => { autoTrainCalls += 1; },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
  assert.equal(autoTrainCalls, 1);
  assert.equal(result.results[0]?.code, "LEARNED_CONFIRMATION_SKIP");
});

test("server monitor skips allocations below Jupiter's collateral minimum", async () => {
  let routeCalls = 0;
  let savedCursor = 0;
  const baseTime = 1_784_174_800_000;
  const points = [100, 100.2, 100.4, 100.8, 101.4, 102].map((value, index) => ({
    t: baseTime + index * 60_000,
    v: value,
  }));
  const base = createConfig();
  const config = createConfig({ settings: { ...base.settings, walletPercent: 80 } });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 6,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => null,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async (_wallet, _asset, _strategyClass, timestamp) => {
      savedCursor = timestamp;
    },
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "COLLATERAL_BELOW_MINIMUM");
  assert.equal(savedCursor, points[points.length - 1]?.t);
});

test("parameter candidates are skipped when the RSI indicator reaches the configured extreme", async () => {
  let routeCalls = 0;
  let savedCursor = 0;
  const baseTime = 1_784_174_800_000;
  const points = Array.from({ length: 70 }, (_, index) => {
    const close = 100 + index * 0.2;
    return {
      t: baseTime + index * 60_000,
      o: close - 0.1,
      h: close + 0.2,
      l: close - 0.2,
      v: close,
      volume: 100 + index,
    };
  });

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    getLearningProfile: async () => null,
    reconcileLearningHistory: async () => 0,
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async (_wallet, _asset, _strategyClass, timestamp) => { savedCursor = timestamp; },
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "INDICATOR_RSI_VETO");
  assert.equal(savedCursor, points[points.length - 1]?.t);
});

test("scalp monitor can route an opposite-side entry while independently managing the current position", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routedSignal: PerpsAgentSignal | null = null;
  let closeCalls = 0;
  let prunedPositionPubkeys: string[] = [];

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(1, {
        id: "existing-short",
        accountRef: "existing-short",
        side: "short",
        unrealizedPnl: 1,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    closePosition: async () => {
      closeCalls += 1;
      return { txid: "unexpected-close" };
    },
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => null,
    writeProfitLockState: async () => undefined,
    pruneProfitLockStates: async (_wallet, activePositionPubkeys) => {
      prunedPositionPubkeys = activePositionPubkeys;
    },
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.equal(routed?.strategyClass, "scalp");
  assert.equal(routed?.direction, "bullish");
  assert.equal(routed?.marketContext?.hasOpenPosition, true);
  assert.equal(routed?.marketContext?.allowConcurrentPosition, true);
  assert.equal(closeCalls, 0);
  assert.deepEqual(prunedPositionPubkeys, ["existing-short"]);
});

test("scalp monitor refuses a second same-side entry instead of merging Jupiter positions", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routeCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [createOpenPosition(1)], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => null,
    writeProfitLockState: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.code, "SAME_SIDE_POSITION_OPEN");
  assert.equal(routeCalls, 0);
});

test("exceptional scalp reversal closes first and records a replacement intent without racing the new order", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routeCalls = 0;
  let closeCalls = 0;
  const savedIntents: Array<{ direction: "bullish" | "bearish"; positionPubkey: string; expiresAt: number }> = [];

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({
      positions: [createOpenPosition(-1, {
        id: "losing-short",
        accountRef: "losing-short",
        side: "short",
        unrealizedPnl: -1,
      })],
      pendingTriggers: [],
      recentTrades: [],
    }),
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    closePosition: async (_wallet, position) => {
      closeCalls += 1;
      assert.equal(position.accountRef, "losing-short");
      return { txid: "reversal-close" };
    },
    writePendingScalpReversal: async (_wallet, intent) => {
      savedIntents.push(intent);
    },
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readProfitLockState: async () => null,
    writeProfitLockState: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(result.results[0]?.code, "SCALP_REVERSAL_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal(routeCalls, 0);
  const savedIntent = savedIntents[0];
  assert.equal(savedIntent?.direction, "bullish");
  assert.equal(savedIntent?.positionPubkey, "losing-short");
  assert.ok((savedIntent?.expiresAt ?? 0) > Date.now());
});

test("scalp reversal replacement opens only after the original position is gone and the signal requalifies", async () => {
  const points = exceptionalBullishSweepPoints();
  const base = createConfig();
  const config = createConfig({
    settings: { ...base.settings, scalpModeEnabled: true },
    params: { ...base.params, trendWindow: 24 },
  });
  let routedSignal: PerpsAgentSignal | null = null;
  let clearCalls = 0;

  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [config],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => points,
    fetchSnapshot: async () => ({ positions: [], pendingTriggers: [], recentTrades: [] }),
    getUsdcBalance: async () => 100,
    routeSignal: (async (_wallet: string, signal: PerpsAgentSignal) => {
      routedSignal = signal;
      return { ok: true, message: "submitted", execution: { status: "submitted" } };
    }) as unknown as RouteSignal,
    readPendingScalpReversal: async () => ({
      positionPubkey: "closed-short",
      direction: "bullish",
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      projectedSurplusUsd: 2,
    }),
    clearPendingScalpReversal: async () => {
      clearCalls += 1;
    },
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  const routed = routedSignal as PerpsAgentSignal | null;
  assert.equal(result.results[0]?.status, "executed");
  assert.equal(routed?.direction, "bullish");
  assert.match(routed?.summary ?? "", /reversal replacement/i);
  assert.equal(clearCalls, 1);
});
