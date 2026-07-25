import assert from "node:assert/strict";
import test from "node:test";

import type { PerpsAutomationConfig } from "../lib/perps/automationConfig";
import { computeTriggerPrices, detectScalpSignal, getScalpTradePlanningConfig, resolveAutonomousCollateralUsd, runAutonomousPerpsMonitor, SCALP_SIGNAL_COOLDOWN_SECONDS } from "../lib/perps/autonomousMonitor";
import type { DecisionLearningProfile } from "../lib/decision/learningTypes";
import type { JupiterPerpsPosition } from "../lib/jupiterPerps";
import {
  calculatePerpsPositionRoePercent,
  evaluatePerpsProfitLock,
  PROFIT_LOCK_ARM_ROE_PERCENT,
  PROFIT_LOCK_EXIT_ROE_PERCENT,
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
      scalpTakeProfitUsd: 3.5,
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
      volumeRatio: 1,
      bollingerBandwidthPercent: 0.6,
      bollingerPosition: 0.12,
    },
  });

  assert.equal(signal?.type, "scalp");
  assert.equal(signal?.direction, "bullish");
});

test("scalp detection uses an independent 25-minute cooldown", () => {
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
    volumeRatio: 1,
    bollingerBandwidthPercent: 0.6,
    bollingerPosition: 0.12,
  };
  const latestTimestamp = points[points.length - 1]!.t;

  assert.equal(SCALP_SIGNAL_COOLDOWN_SECONDS, 1_500);
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

test("scalp trigger pricing covers estimated fees plus the $3.50 minimum net target", () => {
  const config = createConfig();
  const triggers = computeTriggerPrices({
    config,
    entryPrice: 100,
    collateralUsd: 25,
    leverage: 2,
    side: "long",
    stopLossPercent: 0,
    takeProfitPercent: 0,
    takeProfitUsd: 3.5,
  });
  const targetPnl = (((triggers.takeProfitPrice ?? 0) - 100) / 100) * 50;

  assert.ok(targetPnl - 50 * 0.0012 >= 3.499999);
  assert.equal(triggers.stopLossPrice, null);
});

test("scalp planning uses 50 percent wallet allocation", () => {
  const planningConfig = getScalpTradePlanningConfig(createConfig());
  assert.equal(planningConfig.settings.walletAllocationMode, "percent");
  assert.equal(planningConfig.settings.walletPercent, 50);
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

function createOpenPosition(roePercent: number): JupiterPerpsPosition {
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

test("profit lock arms at 25% ROE and closes on a retreat to 20%", () => {
  assert.equal(PROFIT_LOCK_ARM_ROE_PERCENT, 25);
  assert.equal(PROFIT_LOCK_EXIT_ROE_PERCENT, 20);
  assert.equal(calculatePerpsPositionRoePercent(createOpenPosition(25)), 25);

  const armed = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 25,
    previousState: null,
    now: 1_000,
  });
  assert.equal(armed.action, "armed");
  assert.equal(armed.state.peakRoePercent, 25);

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 20,
    previousState: armed.state,
    now: 2_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.state.peakRoePercent, 25);
});

test("profit lock does not close at 20% unless the same position first reached 25%", () => {
  const evaluation = evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 20,
    previousState: null,
    now: 1_000,
  });
  assert.equal(evaluation.action, "track");
  assert.equal(evaluation.state.armedAt, null);
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
    currentRoePercent: 18,
    previousState,
    now: 60_000,
  }).action, "close-pending");
  assert.equal(evaluatePerpsProfitLock({
    positionPubkey: "position-pubkey",
    currentRoePercent: 18,
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
    leverageCap: 10,
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
  assert.ok((routed?.leverage ?? 0) >= 2 && (routed?.leverage ?? 0) <= 10);
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

test("server monitor closes an armed profitable position at 20% even with pending TP and SL", async () => {
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

  const armed = await run(27);
  assert.equal(armed.results[0]?.code, "POSITION_PROFIT_LOCK_ARMED");
  assert.equal(closeCalls, 0);

  const closed = await run(20);
  assert.equal(closed.results[0]?.status, "executed");
  assert.equal(closed.results[0]?.code, "PROFIT_LOCK_CLOSE_SUBMITTED");
  assert.equal(closeCalls, 1);
  assert.equal(profitLockState?.closeTxid, "profit-lock-close-tx");
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
