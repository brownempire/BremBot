import assert from "node:assert/strict";
import test from "node:test";

import type { PerpsAutomationConfig } from "../lib/perps/automationConfig";
import { runAutonomousPerpsMonitor } from "../lib/perps/autonomousMonitor";
import type { DecisionLearningProfile } from "../lib/decision/learningTypes";
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
    writeLastSignal: async (_wallet, _asset, timestamp) => {
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

test("server monitor fails closed when an agent position is already open", async () => {
  let routeCalls = 0;
  const result = await runAutonomousPerpsMonitor({
    listConfigs: async () => [createConfig()],
    listSessions: async () => [createSession()],
    getRuntimeOverride: async () => ({ killSwitchOverride: false, updatedAt: new Date().toISOString() }),
    fetchCandles: async () => [],
    fetchSnapshot: (async () => ({ positions: [{ source: "live-api" }], pendingTriggers: [], recentTrades: [] })) as never,
    getUsdcBalance: async () => 100,
    routeSignal: (async () => {
      routeCalls += 1;
      return { ok: true, message: "unexpected" };
    }) as unknown as RouteSignal,
    reconcileNoOpenPosition: async () => [],
    getAgentWallet: () => "agent-wallet",
    isWalletAllowed: () => true,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "POSITION_ALREADY_OPEN");
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
    autoTrain: async () => undefined,
    readLastSignal: async () => null,
    writeLastSignal: async () => undefined,
  });

  assert.equal(routeCalls, 0);
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
    writeLastSignal: async (_wallet, _asset, timestamp) => {
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
    writeLastSignal: async (_wallet, _asset, timestamp) => { savedCursor = timestamp; },
  });

  assert.equal(routeCalls, 0);
  assert.equal(result.results[0]?.code, "INDICATOR_RSI_VETO");
  assert.equal(savedCursor, points[points.length - 1]?.t);
});
