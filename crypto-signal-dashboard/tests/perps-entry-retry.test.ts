import assert from "node:assert/strict";
import test from "node:test";

import { PerpsExecutionError } from "../lib/perps/errors";
import { createPerpsEntryRetrySignals, executePerpsEntryWithRetries } from "../lib/perps/entryRetry";
import type { PerpsSignalPayload } from "../lib/perps/types";

function signal(): PerpsSignalPayload {
  return {
    signalId: "signal-retry",
    strategyId: "training-baseline",
    market: "SOL-PERP",
    assetMint: "SOL",
    side: "long",
    action: "open",
    collateralUsd: 80,
    sizeUsd: 4_000,
    leverage: 50,
    maxSlippageBps: 100,
    takeProfit: { enabled: true, priceUsd: 100.08 },
    stopLoss: { enabled: true, priceUsd: 99.96 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reason: "Retry test",
    walletAddress: "AgentWallet11111111111111111111111111111111",
    source: "ui-local",
  };
}

test("entry retry ladder reduces collateral and leverage over three attempts", () => {
  const attempts = createPerpsEntryRetrySignals(signal());
  assert.deepEqual(attempts.map((attempt) => ({ collateral: attempt.collateralUsd, leverage: attempt.leverage, size: attempt.sizeUsd })), [
    { collateral: 80, leverage: 50, size: 4_000 },
    { collateral: 60, leverage: 37.5, size: 2_250 },
    { collateral: 40, leverage: 25, size: 1_000 },
  ]);
});

test("the $12 low-balance override keeps Jupiter-compatible collateral on retries", () => {
  const lowBalanceSignal = { ...signal(), collateralUsd: 12, sizeUsd: 120, leverage: 10 };
  const attempts = createPerpsEntryRetrySignals(lowBalanceSignal);

  assert.deepEqual(attempts.map((attempt) => ({ collateral: attempt.collateralUsd, leverage: attempt.leverage })), [
    { collateral: 12, leverage: 10 },
    { collateral: 12, leverage: 7.5 },
    { collateral: 12, leverage: 5 },
  ]);
});

test("confirmed build failures retry and return the successful reduced attempt", async () => {
  let buildCalls = 0;
  const result = await executePerpsEntryWithRetries({
    signal: signal(),
    build: async () => {
      buildCalls += 1;
      if (buildCalls < 3) throw new Error("Invalid leverage parameter");
      return { serializedTxBase64: "built", positionPubkey: "position", tpslMode: "deferred" };
    },
    sign: (serialized) => `signed-${serialized}`,
    submit: async () => ({ txid: "txid", positionPubkey: "position" }),
  });

  assert.equal(result.attemptCount, 3);
  assert.equal(result.signal.collateralUsd, 40);
  assert.equal(result.signal.leverage, 25);
  assert.equal(result.failures.length, 2);
});

test("an ambiguous submission failure never retries and risks no duplicate entry", async () => {
  let buildCalls = 0;
  let submitCalls = 0;
  await assert.rejects(() => executePerpsEntryWithRetries({
    signal: signal(),
    build: async () => {
      buildCalls += 1;
      return { serializedTxBase64: "built", positionPubkey: "position", tpslMode: "bundled" };
    },
    sign: (serialized) => `signed-${serialized}`,
    submit: async () => {
      submitCalls += 1;
      throw new Error("Network timeout after submission");
    },
  }), /Network timeout/);
  assert.equal(buildCalls, 1);
  assert.equal(submitCalls, 1);
});

test("an explicit 422 parameter rejection can retry safely", async () => {
  let submitCalls = 0;
  const result = await executePerpsEntryWithRetries({
    signal: signal(),
    build: async () => ({ serializedTxBase64: "built", positionPubkey: "position", tpslMode: "bundled" }),
    sign: (serialized) => `signed-${serialized}`,
    submit: async () => {
      submitCalls += 1;
      if (submitCalls === 1) throw new PerpsExecutionError("JUPITER_EXECUTE_FAILED", "Invalid leverage parameter", 422);
      return { txid: "txid", positionPubkey: "position" };
    },
  });
  assert.equal(result.attemptCount, 2);
  assert.equal(result.signal.leverage, 37.5);
});
