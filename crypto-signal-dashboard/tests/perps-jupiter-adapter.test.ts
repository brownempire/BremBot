import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEntryWithTpslFallback,
  getInitialPositionTpsl,
  getStandalonePositionTpsl,
  rebaseTakeProfitForLivePosition,
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

test("a deferred scalp TP is rebased to $3.50 net above filled-position break even", () => {
  const rebased = rebaseTakeProfitForLivePosition(
    { side: "short", takeProfit: { enabled: true, priceUsd: 77.44154323703374 } },
    {
      side: "short",
      entryPriceUsd: "77458395",
      markPriceUsd: "77495000",
      sizeUsd: "5253436400",
      totalFeesUsd: "6309618",
    },
    3.5
  );

  assert.equal(typeof rebased, "number");
  if (typeof rebased !== "number") return;
  assert.ok(rebased < 77.33);
  assert.ok(rebased < 77.458395);
});

test("a deferred scalp TP moves beyond the live mark after crossing the old target", () => {
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
