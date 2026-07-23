import assert from "node:assert/strict";
import test from "node:test";

import { evaluateUserScopedPerpsRisk } from "../lib/perps/userScopedRisk";
import type { PerpsAutomationSession, PerpsUserExecution } from "../lib/perps/sessionTypes";

const session: PerpsAutomationSession = {
  sessionId: "risk-session",
  walletAddress: "risk-wallet",
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

function signal(options: { collateralUsd?: number; leverage?: number; availableUsdc?: number } = {}) {
  const collateralUsd = options.collateralUsd ?? 11;
  const leverage = options.leverage ?? 77;
  return {
    signalId: "risk-signal",
    symbol: "SOL/USD",
    summary: "Risk allocation test",
    direction: "bullish" as const,
    asset: "SOL" as const,
    collateralUsd,
    leverage,
    maxSlippageBps: 100,
    marketContext: {
      availableUsdc: options.availableUsdc ?? 17,
    },
    sizeUsd: collateralUsd * leverage,
  };
}

function execution(collateralUsd: number): PerpsUserExecution {
  const now = new Date().toISOString();
  return {
    executionId: "existing-execution",
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    signalId: "existing-signal",
    symbol: "SOL/USD",
    summary: "Existing position",
    side: "long",
    asset: "SOL",
    mode: "live",
    executionModel: "delegated-ready",
    status: "confirmed",
    reasonCode: "APPROVED",
    reasonMessage: "Approved",
    collateralUsd,
    sizeUsd: collateralUsd * 20,
    leverage: 20,
    takeProfitPrice: null,
    stopLossPrice: null,
    txid: "tx",
    positionPubkey: "position",
    createdAt: now,
    updatedAt: now,
  };
}

test("selected collateral passes even when leveraged notional exceeds the old fixed cap", () => {
  const result = evaluateUserScopedPerpsRisk({
    session,
    signal: signal(),
    existingExecutions: [],
    maxLeverage: 125,
    maxTradePct: 3,
    maxExposurePct: 3,
  });

  assert.equal(result.approved, true);
  assert.equal(result.code, "APPROVED");
});

test("percentage-based allocation scales from the live agent balance", () => {
  const result = evaluateUserScopedPerpsRisk({
    session,
    signal: signal({ collateralUsd: 4.25, leverage: 125, availableUsdc: 17 }),
    existingExecutions: [],
    maxLeverage: 125,
    maxTradePct: 3,
    maxExposurePct: 3,
  });

  assert.equal(result.approved, true);
  assert.equal(result.code, "APPROVED");
});

test("trade guardrail compares selected collateral with live wallet capital", () => {
  const result = evaluateUserScopedPerpsRisk({
    session,
    signal: signal(),
    existingExecutions: [],
    maxLeverage: 125,
    maxTradePct: 0.5,
    maxExposurePct: 3,
  });

  assert.equal(result.approved, false);
  assert.equal(result.code, "SIZE_TOO_LARGE");
  assert.match(result.message, /\$8\.5 wallet-allocation guardrail/);
});

test("the isolated $12 low-balance trade bypasses percentage allocation and exposure limits", () => {
  const result = evaluateUserScopedPerpsRisk({
    session,
    signal: signal({ collateralUsd: 12, leverage: 10, availableUsdc: 20 }),
    existingExecutions: [],
    maxLeverage: 125,
    maxTradePct: 0.1,
    maxExposurePct: 0.5,
  });

  assert.equal(result.approved, true);
  assert.equal(result.code, "APPROVED");
});

test("the low-balance bypass does not stack on existing committed collateral", () => {
  const result = evaluateUserScopedPerpsRisk({
    session,
    signal: signal({ collateralUsd: 12, leverage: 10, availableUsdc: 20 }),
    existingExecutions: [execution(2)],
    maxLeverage: 125,
    maxTradePct: 0.1,
    maxExposurePct: 0.5,
  });

  assert.equal(result.approved, false);
  assert.equal(result.code, "SIZE_TOO_LARGE");
});

test("exposure guardrail sums committed collateral instead of leveraged notional", () => {
  const result = evaluateUserScopedPerpsRisk({
    session,
    signal: signal(),
    existingExecutions: [execution(45)],
    maxLeverage: 125,
    maxTradePct: 3,
    maxExposurePct: 3,
  });

  assert.equal(result.approved, false);
  assert.equal(result.code, "EXPOSURE_TOO_HIGH");
  assert.match(result.message, /Committed collateral would reach \$56/);
});
