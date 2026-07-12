import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brembot-perps-agent-"));
process.env.REDIS_URL = "";
process.env.PERPS_SESSIONS_FILE = path.join(tempRoot, "sessions.json");
process.env.PERPS_USER_EXECUTIONS_FILE = path.join(tempRoot, "executions.json");
process.env.PERPS_DECISION_JOURNAL_FILE = path.join(tempRoot, "trade-decision-journal.md");
process.env.PERPS_DECISION_EVENTS_FILE = path.join(tempRoot, "trade-decision-events.ndjson");
process.env.PERPS_KILL_SWITCH = "false";
process.env.PERPS_PAPER_TRADING = "true";
process.env.PERPS_DECISION_SHADOW_MODE = "true";

let tradingAgent: typeof import("../lib/perps/tradingAgent");
let sessionStore: typeof import("../lib/perps/sessionStore");
let auditStore: typeof import("../lib/perps/userExecutionAudit");
let sessionConfig: typeof import("../lib/perps/sessionConfig");

function cleanupStores() {
  for (const file of [
    process.env.PERPS_SESSIONS_FILE,
    process.env.PERPS_USER_EXECUTIONS_FILE,
    process.env.PERPS_DECISION_JOURNAL_FILE,
    process.env.PERPS_DECISION_EVENTS_FILE,
  ]) {
    if (file && fs.existsSync(file)) {
      fs.rmSync(file);
    }
  }
}

test.beforeEach(() => {
  cleanupStores();
  process.env.PERPS_KILL_SWITCH = "false";
  process.env.PERPS_LIVE_ALLOWED_WALLETS = "";
  process.env.PERPS_SESSION_HEARTBEAT_TIMEOUT_MS = "60000";
});

test.before(async () => {
  tradingAgent = await import("../lib/perps/tradingAgent");
  sessionStore = await import("../lib/perps/sessionStore");
  auditStore = await import("../lib/perps/userExecutionAudit");
  sessionConfig = await import("../lib/perps/sessionConfig");
});

test("clock in and clock out persists a wallet-scoped session", async () => {
  const wallet = "TestWallet1111111111111111111111111111111111";
  const session = await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    unlimitedSession: false,
    appOpen: true,
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  assert.equal(session.walletAddress, wallet);
  assert.equal(session.sessionState, "clocked_in");

  const stored = await sessionStore.getPerpsSession(wallet);
  assert.equal(stored?.sessionState, "clocked_in");

  const ended = await tradingAgent.clockOutPerpsSession(wallet, "User exited.");
  assert.equal(ended?.sessionState, "clocked_out");
  assert.equal(ended?.walletConnected, false);
});

test("heartbeat grants a grace window before timing out an inactive session", async () => {
  const wallet = "TestWallet2222222222222222222222222222222222";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const updated = await tradingAgent.heartbeatPerpsSession(wallet, {
    appOpen: false,
    appForeground: false,
    walletConnected: false,
    walletWriteEnabled: false,
    reason: "Backgrounded",
  });

  assert.equal(updated?.sessionState, "clocked_in");
  assert.equal(updated?.warning, "Backgrounded");
  assert.ok(updated?.inactiveSince);

  const stored = await sessionStore.getPerpsSession(wallet);
  assert.ok(stored);
  await sessionStore.savePerpsSession({
    ...stored,
    inactiveSince: new Date(Date.now() - 61_000).toISOString(),
    lastHeartbeatAt: new Date(Date.now() - 61_000).toISOString(),
  });

  const timedOut = await tradingAgent.heartbeatPerpsSession(wallet, {
    appOpen: false,
    appForeground: false,
    walletConnected: false,
    walletWriteEnabled: false,
    reason: "Backgrounded",
  });

  assert.equal(timedOut?.sessionState, "clocked_out");
  assert.match(timedOut?.warning ?? "", /timed out/i);
});

test("paper mode routes a signal only to the clocked-in user session", async () => {
  const wallet = "TestWallet3333333333333333333333333333333333";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-1",
    symbol: "SOL/USD",
    summary: "Bullish breakout",
    direction: "bullish",
    signalConfidence: 0.74,
    asset: "SOL",
    collateralUsd: 25,
    leverage: 2,
    maxSlippageBps: 100,
    marketContext: {
      spotPrice: 82.25,
      volatilityPercent: 2.1,
      trendBias: "bullish",
      availableUsdc: 300,
      hasOpenPosition: false,
      recentPriceChangePercent: 1.8,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.execution.status, "paper_executed");
  assert.equal(result.decision?.shadowMode, true);
  assert.equal(typeof result.decision?.confidenceScore, "number");

  const executions = await auditStore.listUserPerpsExecutions(wallet);
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.signalId, "sig-1");
  assert.equal(executions[0]?.decisionShadowMode, true);

  const journalPath = process.env.PERPS_DECISION_JOURNAL_FILE!;
  assert.equal(fs.existsSync(journalPath), true);
  const journal = fs.readFileSync(journalPath, "utf8");
  assert.match(journal, /BremLogic Trade Decision Journal/);
  assert.match(journal, /SOL\/USD/);
  assert.match(journal, /shadow mode on/);
});

test("duplicate signals are blocked within the same user scope", async () => {
  const wallet = "TestWallet4444444444444444444444444444444444";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const payload = {
    signalId: "sig-dup",
    symbol: "ETH/USD",
    summary: "Bullish ETH",
    direction: "bullish" as const,
    asset: "ETH" as const,
    collateralUsd: 20,
    leverage: 2,
    maxSlippageBps: 100,
  };

  const first = await tradingAgent.routePerpsSignalForUser(wallet, payload);
  const second = await tradingAgent.routePerpsSignalForUser(wallet, payload);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, "DUPLICATE_SIGNAL");
});

test("kill switch blocks user-scoped routing", async () => {
  process.env.PERPS_KILL_SWITCH = "true";
  const wallet = "TestWallet5555555555555555555555555555555555";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-kill",
    symbol: "BTC/USD",
    summary: "Kill switch test",
    direction: "bullish",
    asset: "BTC",
    collateralUsd: 10,
    leverage: 1,
    maxSlippageBps: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "KILL_SWITCH");
});

test("live mode remains approval-assisted and fails closed without wallet write capability", async () => {
  const wallet = "TestWallet6666666666666666666666666666666666";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "live",
    platform: "web",
    walletProvider: "Phantom",
  });

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-live",
    symbol: "SOL/USD",
    summary: "Live approval test",
    direction: "bullish",
    asset: "SOL",
    collateralUsd: 10,
    leverage: 1,
    maxSlippageBps: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "WALLET_WRITE_UNAVAILABLE");
});

test("live wallet allowlist only enables configured wallets", () => {
  const approvedWallet = "ApprovedWallet7777777777777777777777777777777";
  const otherWallet = "OtherWallet888888888888888888888888888888888";

  process.env.PERPS_LIVE_ALLOWED_WALLETS = `${approvedWallet}, AnotherWallet9999999999999999999999999999999`;

  assert.equal(sessionConfig.isPerpsLiveWalletAllowed(approvedWallet), true);
  assert.equal(sessionConfig.isPerpsLiveWalletAllowed(otherWallet), false);
  assert.equal(sessionConfig.isPerpsLiveWalletAllowed(null), false);
});
