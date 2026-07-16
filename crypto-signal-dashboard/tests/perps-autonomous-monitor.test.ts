import assert from "node:assert/strict";
import test from "node:test";

import type { PerpsAutomationConfig } from "../lib/perps/automationConfig";
import { runAutonomousPerpsMonitor } from "../lib/perps/autonomousMonitor";
import type { PerpsAgentSignal, PerpsAutomationSession } from "../lib/perps/sessionTypes";

type RouteSignal = typeof import("../lib/perps/tradingAgent").routePerpsSignalForUser;

const walletAddress = "owner-wallet";

function createConfig(overrides: Partial<PerpsAutomationConfig> = {}): PerpsAutomationConfig {
  return {
    walletAddress,
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
