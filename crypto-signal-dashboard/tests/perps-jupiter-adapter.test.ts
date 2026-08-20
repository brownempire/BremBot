import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCompleteJupiterRpcOwnerAccountClassification,
  isAuthoritativeJupiterRpcPositionAbsence,
} from "../lib/jupiterPerps";
import {
  buildEntryWithTpslFallback,
  getInitialPositionTpsl,
  getStandalonePositionTpsl,
  LivePositionTriggerAlreadyCrossedError,
  rebaseTakeProfitForLivePosition,
  rebaseTpslForLivePosition,
} from "../lib/perps/tpslPlan";
import type { PerpsSignalPayload } from "../lib/perps/types";

function signal(): PerpsSignalPayload {
  return {
    signalId: "signal-tpsl",
    strategyId: "test",
    market: "SOL-PERP",
    assetMint: "SOL",
    side: "long",
    action: "open",
    collateralUsd: 11,
    sizeUsd: 847,
    leverage: 77,
    maxSlippageBps: 100,
    takeProfit: { enabled: true, priceUsd: 77.25 },
    stopLoss: { enabled: true, priceUsd: 75.5 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reason: "Test TP/SL",
    walletAddress: "AgentWallet11111111111111111111111111111111",
    source: "ui-local",
  };
}

test("RPC absence is authoritative only for a clean empty owner-account scan", () => {
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 0,
    decodeFailureCount: 0,
    unclassifiedAccountCount: 0,
  }), true);
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 1,
    decodeFailureCount: 0,
    unclassifiedAccountCount: 0,
  }), false);
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 0,
    decodeFailureCount: 1,
    unclassifiedAccountCount: 1,
  }), false);
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 0,
    decodeFailureCount: 0,
    unclassifiedAccountCount: 1,
  }), false);
});

test("RPC inventory rejects a decoded position mixed with an unclassified owner account", () => {
  assert.throws(() => assertCompleteJupiterRpcOwnerAccountClassification({
    ownerAccountCount: 2,
    positionCount: 1,
    pendingTriggerCount: 0,
    unclassifiedAccountCount: 1,
  }), /exposure is incomplete/i);

  assert.doesNotThrow(() => assertCompleteJupiterRpcOwnerAccountClassification({
    ownerAccountCount: 2,
    positionCount: 1,
    pendingTriggerCount: 1,
    unclassifiedAccountCount: 0,
  }));
});

test("nested and standalone TP/SL requests use Jupiter raw USD prices", () => {
  assert.deepEqual(getInitialPositionTpsl(signal()), [
    { receiveToken: "USDC", requestType: "tp", triggerPrice: "77250000" },
    { receiveToken: "USDC", requestType: "sl", triggerPrice: "75500000" },
  ]);
  assert.deepEqual(getStandalonePositionTpsl(signal()), [
    { entirePosition: true, receiveToken: "USDC", requestType: "tp", triggerPrice: "77250000" },
    { entirePosition: true, receiveToken: "USDC", requestType: "sl", triggerPrice: "75500000" },
  ]);
});

test("a deferred scalp TP preserves its volatility target above fees and the net-profit floor", () => {
  const rebased = rebaseTakeProfitForLivePosition(
    { side: "short", takeProfit: { enabled: true, priceUsd: 77.44154323703374 } },
    {
      side: "short",
      entryPriceUsd: "77458395",
      markPriceUsd: "77495000",
      sizeUsd: "5253436400",
      totalFeesUsd: "6309618",
    },
    1
  );

  assert.equal(typeof rebased, "number");
  if (typeof rebased !== "number") return;
  assert.ok(rebased < 77.44);
  assert.ok(rebased < 77.458395);
});

test("deferred scalp protection rebases both TP and SL from the confirmed fill", () => {
  const rebased = rebaseTpslForLivePosition(
    {
      side: "long",
      referenceEntryPriceUsd: 100,
      estimatedRoundTripFeeRate: 0.00205,
      takeProfit: { enabled: true, priceUsd: 102 },
      stopLoss: { enabled: true, priceUsd: 99 },
    },
    {
      side: "long",
      entryPriceUsd: "101000000",
      markPriceUsd: "101200000",
      sizeUsd: "1000000000",
      totalFeesUsd: "1000000",
    }
  );

  assert.equal(Number(rebased.takeProfitPrice?.toFixed(6)), 103.02);
  assert.equal(Number(rebased.stopLossPrice?.toFixed(6)), 99.99);
});

test("legacy non-scalp deferred TP behavior still moves beyond a crossed live mark", () => {
  const rebased = rebaseTakeProfitForLivePosition(
    { side: "long", takeProfit: { enabled: true, priceUsd: 100.02 } },
    {
      side: "long",
      entryPriceUsd: "100000000",
      markPriceUsd: "100200000",
      sizeUsd: "5000000000",
      totalFeesUsd: "6000000",
    }
  );

  assert.equal(typeof rebased, "number");
  if (typeof rebased !== "number") return;
  assert.ok(rebased > 100.2);
});

for (const testCase of [
  { name: "long TP", side: "long" as const, takeProfit: 101, stopLoss: 99, mark: 102.1, kind: "take-profit" },
  { name: "short TP", side: "short" as const, takeProfit: 99, stopLoss: 101, mark: 98, kind: "take-profit" },
  { name: "long SL", side: "long" as const, takeProfit: 102, stopLoss: 99, mark: 99.98, kind: "stop-loss" },
  { name: "short SL", side: "short" as const, takeProfit: 98, stopLoss: 101, mark: 100.02, kind: "stop-loss" },
]) {
  test(`a crossed ${testCase.name} requests an immediate close instead of widening protection`, () => {
    assert.throws(() => rebaseTpslForLivePosition(
      {
        side: testCase.side,
        referenceEntryPriceUsd: 100,
        takeProfit: { enabled: true, priceUsd: testCase.takeProfit },
        stopLoss: { enabled: true, priceUsd: testCase.stopLoss },
      },
      {
        side: testCase.side,
        entryPriceUsd: testCase.side === "long" ? "101000000" : "99000000",
        markPriceUsd: String(Math.round(testCase.mark * 1_000_000)),
        sizeUsd: "5000000000",
        totalFeesUsd: "5000000",
      }
    ), (error: unknown) => (
      error instanceof LivePositionTriggerAlreadyCrossedError
      && error.triggerKind === testCase.kind
    ));
  });
}

test("a nested TP/SL builder failure falls back to an entry transaction and defers protection", async () => {
  const requests: unknown[] = [];
  const built = await buildEntryWithTpslFallback(getInitialPositionTpsl(signal()), async (tpsl) => {
    requests.push(tpsl);
    if (tpsl.length) throw new Error("500 Internal Server Error");
    return { serializedTxBase64: "entry-transaction", tpsl: [] };
  });
  assert.equal(requests.length, 2);
  assert.equal(built.response.serializedTxBase64, "entry-transaction");
  assert.equal(built.tpslMode, "deferred");
});

test("a successful nested builder reports bundled TP/SL protection", async () => {
  const built = await buildEntryWithTpslFallback(getInitialPositionTpsl(signal()), async () => ({
    serializedTxBase64: "bundled-transaction",
    tpsl: [{ requestType: "tp" }, { requestType: "sl" }],
  }));
  assert.equal(built.tpslMode, "bundled");
});

test("scalp entries force deferred protection so confirmed fill prices are available", async () => {
  const requests: unknown[] = [];
  const built = await buildEntryWithTpslFallback(
    getInitialPositionTpsl(signal()),
    async (tpsl) => {
      requests.push(tpsl);
      return { serializedTxBase64: "entry-only", tpsl: [] };
    },
    { forceDeferredProtection: true }
  );

  assert.deepEqual(requests, [[]]);
  assert.equal(built.tpslMode, "deferred");
});
