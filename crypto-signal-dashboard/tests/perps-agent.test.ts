import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brembot-perps-agent-"));
process.env.REDIS_URL = "";
process.env.PERPS_SESSIONS_FILE = path.join(tempRoot, "sessions.json");
process.env.PERPS_USER_EXECUTIONS_FILE = path.join(tempRoot, "executions.json");
process.env.PERPS_USER_EXECUTION_FEED_STATE_FILE = path.join(tempRoot, "execution-feed-state.json");
process.env.PERPS_DECISION_JOURNAL_FILE = path.join(tempRoot, "trade-decision-journal.md");
process.env.PERPS_DECISION_EVENTS_FILE = path.join(tempRoot, "trade-decision-events.ndjson");
process.env.PERPS_KILL_SWITCH = "false";
process.env.PERPS_PAPER_TRADING = "true";
process.env.PERPS_DECISION_SHADOW_MODE = "true";

let tradingAgent: typeof import("../lib/perps/tradingAgent");
let sessionStore: typeof import("../lib/perps/sessionStore");
let auditStore: typeof import("../lib/perps/userExecutionAudit");
let sessionConfig: typeof import("../lib/perps/sessionConfig");
let decisionEngine: typeof import("../lib/decision/engine");

function cleanupStores() {
  for (const file of [
    process.env.PERPS_SESSIONS_FILE,
    process.env.PERPS_USER_EXECUTIONS_FILE,
    process.env.PERPS_USER_EXECUTION_FEED_STATE_FILE,
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
  process.env.PERPS_DECISION_SHADOW_MODE = "true";
  delete process.env.PERPS_DECISION_ALLOW_OVERRIDES;
  delete process.env.PERPS_MAX_LEVERAGE;
  delete process.env.PERPS_MAX_TRADE_PCT;
  delete process.env.PERPS_MAX_EXPOSURE_PCT;
  delete process.env.PERPS_AGENT_OWNER_WALLET;
  delete process.env.PERPS_AGENT_WALLET_PUBLIC_KEY;
  delete process.env.PERPS_AGENT_WALLET_PRIVATE_KEY;
  delete process.env.PERPS_AGENT_WALLET_ASSOCIATIONS;
});

test.before(async () => {
  tradingAgent = await import("../lib/perps/tradingAgent");
  sessionStore = await import("../lib/perps/sessionStore");
  auditStore = await import("../lib/perps/userExecutionAudit");
  sessionConfig = await import("../lib/perps/sessionConfig");
  decisionEngine = await import("../lib/decision/engine");
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

test("set-parameter execution remains authoritative when the decision layer is active", async () => {
  process.env.PERPS_DECISION_SHADOW_MODE = "false";
  process.env.PERPS_DECISION_ALLOW_OVERRIDES = "true";
  process.env.PERPS_MAX_LEVERAGE = "10";
  process.env.PERPS_MAX_TRADE_PCT = "1";
  process.env.PERPS_MAX_EXPOSURE_PCT = "1";
  const wallet = "TestWalletSetParams33333333333333333333333333";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-set-params-active-decision",
    symbol: "SOL/USD",
    summary: "Saved parameters remain authoritative",
    direction: "bullish",
    signalConfidence: 0.3,
    asset: "SOL",
    collateralUsd: 80,
    leverage: 8,
    maxSlippageBps: 100,
    executionStyle: "set-parameters",
    marketContext: {
      spotPrice: 80,
      volatilityPercent: 1,
      trendBias: "sideways",
      availableUsdc: 100,
      hasOpenPosition: false,
      recentPriceChangePercent: 0.1,
    },
  });

  assert.equal(result.decision?.shouldTrade, false);
  assert.equal(result.ok, true);
  assert.equal(result.execution.status, "paper_executed");
  assert.equal(result.execution.collateralUsd, 80);
  assert.equal(result.execution.leverage, 8);
});

test("authoritative scalp reversal is not vetoed by Smart leverage, allocation, trend, or blocked-history scoring", async () => {
  process.env.PERPS_DECISION_SHADOW_MODE = "false";
  process.env.PERPS_MAX_LEVERAGE = "50";
  process.env.PERPS_MAX_TRADE_PCT = "1";
  process.env.PERPS_MAX_EXPOSURE_PCT = "1";
  const wallet = "TestWalletWeakScalp3333333333333333333333333";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-authoritative-scalp-reversal",
    symbol: "SOL/USD",
    summary: "Confirmed liquidity-sweep reversal",
    direction: "bearish",
    signalConfidence: 0.886,
    asset: "SOL",
    collateralUsd: 50,
    leverage: 50,
    takeProfitPrice: 99.8,
    stopLossPrice: 100.8,
    maxSlippageBps: 100,
    executionStyle: "set-parameters",
    strategyClass: "scalp",
    strategyContext: {
      signalType: "scalp",
      trendWindow: 24,
      trendThreshold: 0,
      breakoutPercent: 0,
      cooldownSeconds: 1_500,
      trendStrengthPercent: 0,
      breakoutStrengthPercent: 0,
      atrPercent: 0.18,
      scalpSetupType: "liquidity-sweep",
      priceActionScore: 0.96,
      priceActionTags: [
        "SCALP_LIQUIDITY_SWEEP",
        "SCALP_RECLAIM",
        "EXCEPTIONAL_CONFIRMED_PRICE_ACTION",
      ],
      indicatorBypass: true,
    },
    marketContext: {
      spotPrice: 100,
      volatilityPercent: 1.5,
      trendBias: "sideways",
      availableUsdc: 100,
      hasOpenPosition: false,
      recentPriceChangePercent: 0,
    },
  });

  assert.equal(result.decision?.shouldTrade, true);
  assert.equal(result.ok, true);
  assert.equal(result.execution.status, "paper_executed");
  assert.equal(result.execution.collateralUsd, 50);
  assert.equal(result.execution.leverage, 50);
  assert.equal(result.decision?.explanationTags.includes("scalp-detector-authoritative"), true);
  assert.equal(result.decision?.explanationTags.includes("very-high-leverage"), false);
  assert.equal(result.decision?.explanationTags.includes("heavy-wallet-allocation"), false);
  assert.equal(result.decision?.explanationTags.includes("recent-blocked-drag"), false);
  assert.equal(result.decision?.explanationTags.includes("trend-counter"), false);
});

test("a scalp-labeled request that did not come from the scalp detector fails closed", async () => {
  process.env.PERPS_DECISION_SHADOW_MODE = "false";
  process.env.PERPS_MAX_LEVERAGE = "50";
  process.env.PERPS_MAX_TRADE_PCT = "1";
  process.env.PERPS_MAX_EXPOSURE_PCT = "1";
  const wallet = "TestWalletUnverifiedScalp333333333333333333333";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-unverified-scalp",
    symbol: "SOL/USD",
    summary: "Unverified scalp label",
    direction: "bearish",
    signalConfidence: 0.99,
    asset: "SOL",
    collateralUsd: 10,
    leverage: 50,
    takeProfitPrice: 99.8,
    stopLossPrice: 100.8,
    maxSlippageBps: 100,
    executionStyle: "set-parameters",
    strategyClass: "scalp",
    marketContext: {
      spotPrice: 100,
      volatilityPercent: 1.5,
      trendBias: "sideways",
      availableUsdc: 100,
      hasOpenPosition: false,
      recentPriceChangePercent: 0,
    },
  });

  assert.equal(result.decision?.shouldTrade, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, "DECISION_LAYER_SKIP");
  assert.equal(result.decision?.explanationTags.includes("scalp-detector-context-required"), true);
});

test("scalp execution fails closed when a required protection is missing", async () => {
  process.env.PERPS_DECISION_SHADOW_MODE = "false";
  process.env.PERPS_MAX_LEVERAGE = "50";
  process.env.PERPS_MAX_TRADE_PCT = "1";
  process.env.PERPS_MAX_EXPOSURE_PCT = "1";
  const wallet = "TestWalletMissingScalpProtection333333333333333";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-scalp-missing-stop",
    symbol: "SOL/USD",
    summary: "Scalp missing stop protection",
    direction: "bullish",
    signalConfidence: 0.9,
    asset: "SOL",
    collateralUsd: 12,
    leverage: 10,
    takeProfitPrice: 100.2,
    stopLossPrice: null,
    maxSlippageBps: 100,
    executionStyle: "set-parameters",
    strategyClass: "scalp",
    protectionOverride: {
      allowDecisionRejection: true,
      reason: "Operator-approved decision exception for this protected test signal.",
    },
    marketContext: {
      spotPrice: 100,
      volatilityPercent: 1,
      trendBias: "bullish",
      availableUsdc: 25,
      hasOpenPosition: false,
      recentPriceChangePercent: 0.2,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SCALP_PROTECTION_REQUIRED");
  assert.equal(result.execution.status, "blocked");
  assert.match(result.message, /stop loss/i);
});

test("a structured reasoned signal override is required to bypass a scalp protection", async () => {
  process.env.PERPS_DECISION_SHADOW_MODE = "false";
  process.env.PERPS_MAX_LEVERAGE = "50";
  process.env.PERPS_MAX_TRADE_PCT = "1";
  process.env.PERPS_MAX_EXPOSURE_PCT = "1";
  const wallet = "TestWalletExplicitScalpOverride33333333333333333";
  await tradingAgent.clockInPerpsSession(wallet, {
    mode: "paper",
    platform: "native",
    walletProvider: "Jupiter Mobile",
  });
  const overrideReason = "Signal explicitly requests a stop exception after external hedge confirmation.";

  const result = await tradingAgent.routePerpsSignalForUser(wallet, {
    signalId: "sig-scalp-explicit-protection-override",
    symbol: "SOL/USD",
    summary: "Externally hedged scalp",
    direction: "bullish",
    signalConfidence: 0.9,
    asset: "SOL",
    collateralUsd: 12,
    leverage: 10,
    takeProfitPrice: 100.2,
    stopLossPrice: null,
    maxSlippageBps: 100,
    executionStyle: "set-parameters",
    strategyClass: "scalp",
    protectionOverride: {
      allowDecisionRejection: true,
      allowMissingStopLoss: true,
      reason: overrideReason,
    },
    marketContext: {
      spotPrice: 100,
      volatilityPercent: 1,
      trendBias: "bullish",
      availableUsdc: 25,
      hasOpenPosition: false,
      recentPriceChangePercent: 0.2,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.execution.status, "paper_executed");
  assert.equal(result.execution.protectionOverrideReason, overrideReason);
  assert.deepEqual(result.execution.protectionOverrideScopes, [
    "decision-rejection",
    "missing-stop-loss",
  ]);
  assert.ok(result.execution.decisionTags?.includes("explicit-protection-override"));
});

test("stale operational failures remain auditable but leave recent decision history", () => {
  const staleAt = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
  const session = {
    sessionId: "session-stale-history",
    walletAddress: "wallet-stale-history",
    sessionState: "clocked_in" as const,
    startedAt: staleAt,
    lastHeartbeatAt: new Date().toISOString(),
    inactiveSince: null,
    endedAt: null,
    mode: "live" as const,
    executionModel: "delegated-ready" as const,
    appOpen: false,
    appForeground: false,
    walletConnected: true,
    walletWriteEnabled: true,
    killSwitch: false,
    unlimitedSession: true,
    platform: "native" as const,
    walletProvider: "Agent wallet",
    warning: null,
  };
  const staleFailure = {
    executionId: "old-failure",
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    signalId: "old-signal",
    symbol: "SOL/USD",
    summary: "Old collateral error",
    side: "long" as const,
    asset: "SOL" as const,
    mode: "live" as const,
    executionModel: "delegated-ready" as const,
    status: "failed" as const,
    reasonCode: "APPROVED",
    reasonMessage: "Approved before the wallet was funded.",
    collateralUsd: 4.8,
    sizeUsd: 240,
    leverage: 50,
    takeProfitPrice: null,
    stopLossPrice: null,
    txid: null,
    errorMessage: "Collateral size must be at least $10 for new positions",
    positionPubkey: null,
    createdAt: staleAt,
    updatedAt: staleAt,
  };
  const payload = decisionEngine.buildTradeDecisionPayload({
    walletAddress: session.walletAddress,
    session,
    existingExecutions: [staleFailure],
    signal: {
      signalId: "new-signal",
      symbol: "SOL/USD",
      summary: "Current funded-wallet signal",
      direction: "bullish",
      asset: "SOL",
      collateralUsd: 65,
      leverage: 50,
      maxSlippageBps: 100,
      executionStyle: "set-parameters",
    },
  });
  const recommendation = decisionEngine.evaluateTradeDecision(payload);

  assert.equal(payload.historyContext.recentExecutionCount, 0);
  assert.equal(payload.historyContext.failedCount, 0);
  assert.equal(recommendation.explanationTags.includes("recent-operational-failures-recorded"), false);
});

test("clearing the execution feed preserves wallet audit records and accepts later executions", async () => {
  const wallet = "TestWalletFeed333333333333333333333333333333";
  const baseExecution = {
    executionId: "feed-old",
    sessionId: "session-feed",
    walletAddress: wallet,
    signalId: "signal-old",
    symbol: "SOL/USD",
    summary: "Old execution",
    side: "long" as const,
    asset: "SOL" as const,
    mode: "paper" as const,
    executionModel: "approval-assisted" as const,
    status: "paper_executed" as const,
    reasonCode: "PAPER_EXECUTED",
    reasonMessage: "Recorded before the feed was cleared.",
    collateralUsd: 10,
    sizeUsd: 20,
    leverage: 2,
    takeProfitPrice: null,
    stopLossPrice: null,
    txid: null,
    positionPubkey: null,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    updatedAt: new Date(Date.now() - 1_000).toISOString(),
  };
  await auditStore.createUserPerpsExecution(baseExecution);

  await auditStore.clearUserPerpsExecutionFeed(wallet);
  assert.equal((await auditStore.listVisibleUserPerpsExecutions(wallet)).length, 0);
  assert.equal((await auditStore.listUserPerpsExecutions(wallet)).length, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await auditStore.createUserPerpsExecution({
    ...baseExecution,
    executionId: "feed-new",
    signalId: "signal-new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const visible = await auditStore.listVisibleUserPerpsExecutions(wallet);
  assert.deepEqual(visible.map((entry) => entry.executionId), ["feed-new"]);
  assert.equal((await auditStore.listUserPerpsExecutions(wallet)).length, 2);
});

test("durable execution history is not truncated at the former 100-record display cap", async () => {
  const wallet = "TestWalletHistory333333333333333333333333333";
  const createdAt = new Date().toISOString();
  for (let index = 0; index < 105; index += 1) {
    await auditStore.createUserPerpsExecution({
      executionId: `history-${index}`,
      sessionId: "session-history",
      walletAddress: wallet,
      signalId: `signal-${index}`,
      symbol: "SOL/USD",
      summary: "Persistent history test",
      side: "long",
      asset: "SOL",
      mode: "paper",
      executionModel: "approval-assisted",
      status: "paper_executed",
      reasonCode: "PAPER_EXECUTED",
      reasonMessage: "Stored for durable history.",
      collateralUsd: 10,
      sizeUsd: 20,
      leverage: 2,
      takeProfitPrice: null,
      stopLossPrice: null,
      txid: null,
      positionPubkey: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  assert.equal((await auditStore.listUserPerpsExecutions(wallet)).length, 105);
});

test("completed on-chain executions remain visible as successful closed trades", async () => {
  const wallet = "TestWalletClosed444444444444444444444444444";
  const oldTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();
  await auditStore.createUserPerpsExecution({
    executionId: "closed-success",
    sessionId: "session-closed",
    walletAddress: wallet,
    signalId: "signal-closed",
    symbol: "SOL/USD",
    summary: "Successful live trade",
    side: "long",
    asset: "SOL",
    mode: "live",
    executionModel: "delegated-ready",
    status: "submitted",
    reasonCode: "APPROVED",
    reasonMessage: "Submitted successfully.",
    collateralUsd: 10,
    sizeUsd: 50,
    leverage: 5,
    takeProfitPrice: null,
    stopLossPrice: null,
    txid: "successful-tx",
    positionPubkey: "successful-position",
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp,
  });

  await auditStore.reconcileUserExecutionsWithoutOpenPosition(wallet);
  const [execution] = await auditStore.listVisibleUserPerpsExecutions(wallet);
  assert.equal(execution?.status, "closed");
  assert.equal(execution?.txid, "successful-tx");
  assert.match(execution?.reasonMessage ?? "", /Trade completed/);
});

test("legacy POSITION_CLOSED cancellations with transaction evidence are restored as closed trades", async () => {
  const wallet = "TestWalletLegacyClosed5555555555555555555555555";
  const timestamp = new Date(Date.now() - 5 * 60_000).toISOString();
  await auditStore.createUserPerpsExecution({
    executionId: "legacy-closed",
    sessionId: "session-legacy",
    walletAddress: wallet,
    signalId: "signal-legacy",
    symbol: "BTC/USD",
    summary: "Legacy successful trade",
    side: "short",
    asset: "BTC",
    mode: "live",
    executionModel: "delegated-ready",
    status: "cancelled",
    reasonCode: "POSITION_CLOSED",
    reasonMessage: "No matching open agent position remains on Jupiter Perps.",
    collateralUsd: 10,
    sizeUsd: 30,
    leverage: 3,
    takeProfitPrice: null,
    stopLossPrice: null,
    txid: "legacy-successful-tx",
    positionPubkey: "legacy-position",
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const [execution] = await auditStore.listUserPerpsExecutions(wallet);
  assert.equal(execution?.status, "closed");
});

test("recent submissions receive a reconciliation grace window", async () => {
  const wallet = "TestWalletGrace666666666666666666666666666";
  const timestamp = new Date().toISOString();
  await auditStore.createUserPerpsExecution({
    executionId: "recent-submission",
    sessionId: "session-recent",
    walletAddress: wallet,
    signalId: "signal-recent",
    symbol: "ETH/USD",
    summary: "Recent live trade",
    side: "long",
    asset: "ETH",
    mode: "live",
    executionModel: "delegated-ready",
    status: "submitted",
    reasonCode: "APPROVED",
    reasonMessage: "Submitted successfully.",
    collateralUsd: 10,
    sizeUsd: 20,
    leverage: 2,
    takeProfitPrice: null,
    stopLossPrice: null,
    txid: "recent-tx",
    positionPubkey: "recent-position",
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await auditStore.reconcileUserExecutionsWithoutOpenPosition(wallet);
  const [execution] = await auditStore.listUserPerpsExecutions(wallet);
  assert.equal(execution?.status, "submitted");
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
    marketContext: {
      availableUsdc: 200,
    },
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

test("a matching associated agent signer enables delegated-ready live sessions", async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const agent = Keypair.generate();
  process.env.PERPS_AGENT_OWNER_WALLET = owner;
  process.env.PERPS_AGENT_WALLET_PUBLIC_KEY = agent.publicKey.toBase58();
  process.env.PERPS_AGENT_WALLET_PRIVATE_KEY = JSON.stringify(Array.from(agent.secretKey));

  const session = await tradingAgent.clockInPerpsSession(owner, {
    mode: "live",
    platform: "web",
    walletProvider: "Phantom",
  });

  assert.equal(session.executionModel, "delegated-ready");
  assert.equal(session.walletWriteEnabled, true);

  const backgrounded = await tradingAgent.heartbeatPerpsSession(owner, {
    appOpen: false,
    appForeground: false,
    walletConnected: false,
  });
  assert.equal(backgrounded?.sessionState, "clocked_in");
  assert.equal(backgrounded?.walletWriteEnabled, true);
});

test("live wallet allowlist only enables configured wallets", () => {
  const approvedWallet = "ApprovedWallet7777777777777777777777777777777";
  const otherWallet = "OtherWallet888888888888888888888888888888888";

  process.env.PERPS_LIVE_ALLOWED_WALLETS = `${approvedWallet}, AnotherWallet9999999999999999999999999999999`;

  assert.equal(sessionConfig.isPerpsLiveWalletAllowed(approvedWallet), true);
  assert.equal(sessionConfig.isPerpsLiveWalletAllowed(otherWallet), false);
  assert.equal(sessionConfig.isPerpsLiveWalletAllowed(null), false);
});

test("decision logging remains non-fatal when its directory cannot be created", async () => {
  const blocker = path.join(tempRoot, "not-a-directory");
  fs.writeFileSync(blocker, "blocker", "utf8");
  process.env.PERPS_DECISION_JOURNAL_FILE = path.join(blocker, "journal.md");
  process.env.PERPS_DECISION_EVENTS_FILE = path.join(blocker, "events.ndjson");
  const { appendTradeDecisionRecord } = await import("../lib/decision/logStore");

  await assert.doesNotReject(() => appendTradeDecisionRecord({
    payload: {
      decisionId: "decision-non-fatal",
      createdAt: new Date().toISOString(),
      walletAddress: "wallet",
      sessionId: "session",
      sessionMode: "paper",
      executionModel: "approval-assisted",
      signalId: "signal",
      symbol: "SOL/USD",
      summary: "Logging failure must not block execution.",
      direction: "bullish",
      signalConfidence: 0.8,
      asset: "SOL",
      requestedTrade: {
        collateralUsd: 10,
        leverage: 1,
        takeProfitPrice: null,
        stopLossPrice: null,
        maxSlippageBps: 100,
        executionStyle: null,
        smartTradeProfile: null,
      },
      marketContext: {
        spotPrice: 100,
        volatilityPercent: 1,
        trendBias: "bullish",
        availableUsdc: 100,
        hasOpenPosition: false,
        recentPriceChangePercent: 1,
      },
      historyContext: {
        recentExecutionCount: 0,
        approvalRequiredCount: 0,
        submittedCount: 0,
        confirmedCount: 0,
        paperExecutedCount: 0,
        blockedCount: 0,
        failedCount: 0,
        recentFailureRate: 0,
        recentBlockedRate: 0,
      },
      shadowMode: true,
    },
    recommendation: {
      shouldTrade: true,
      confidenceScore: 0.8,
      riskGrade: "low",
      sizeMultiplier: 1,
      leverageMultiplier: 1,
      recommendedCollateralUsd: 10,
      recommendedLeverage: 1,
      recommendedTakeProfitPrice: null,
      recommendedStopLossPrice: null,
      explanationTags: ["test"],
      explanationSummary: "Test",
      shadowMode: true,
    },
  }));

  process.env.PERPS_DECISION_JOURNAL_FILE = path.join(tempRoot, "trade-decision-journal.md");
  process.env.PERPS_DECISION_EVENTS_FILE = path.join(tempRoot, "trade-decision-events.ndjson");
});
