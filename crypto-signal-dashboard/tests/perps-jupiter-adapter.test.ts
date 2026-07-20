import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateActualPositionProtection,
  getEntryPositionTpsl,
  getStandalonePositionTpsl,
  parseActualPositionForProtection,
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

test("standalone TP/SL requests use Jupiter raw USD prices", () => {
  assert.deepEqual(getStandalonePositionTpsl(signal()), [
    { entirePosition: true, receiveToken: "USDC", requestType: "tp", triggerPrice: "77250000" },
    { entirePosition: true, receiveToken: "USDC", requestType: "sl", triggerPrice: "75500000" },
  ]);
});

test("actual position TP uses the fill, live size, fees, and Jupiter market side", () => {
  const protection = calculateActualPositionProtection({
    position: {
      side: "long",
      entryPriceUsd: 77.492,
      markPriceUsd: 77.455397,
      sizeUsd: 4_451.98045,
      totalFeesUsd: 5.366203,
    },
    referencePriceUsd: 77.51,
    referenceSizeUsd: 4_619.22,
    requestedTakeProfitPrice: 77.54355974325433,
    requestedStopLossPrice: null,
    minimumTakeProfitUsd: 2,
  });
  assert.ok(protection.takeProfitPrice > 77.492);
  assert.equal(protection.takeProfitPrice, 77.620217);
  assert.equal(protection.targetNetProfitUsd, 2);
  assert.equal(protection.stopLossPrice, null);
});

test("actual position TP stays beyond a fast-moving mark price", () => {
  const protection = calculateActualPositionProtection({
    position: {
      side: "long",
      entryPriceUsd: 77.492,
      markPriceUsd: 78,
      sizeUsd: 4_451.98045,
      totalFeesUsd: 5.366203,
    },
    referencePriceUsd: 77.51,
    referenceSizeUsd: 4_619.22,
    requestedTakeProfitPrice: 77.54355974325433,
    minimumTakeProfitUsd: 2,
  });
  assert.equal(protection.takeProfitPrice, 78.078);
});

test("scalp protection preserves a $3.50 minimum net target after fees", () => {
  const protection = calculateActualPositionProtection({
    position: {
      side: "long",
      entryPriceUsd: 77.492,
      markPriceUsd: 77.455397,
      sizeUsd: 4_451.98045,
      totalFeesUsd: 5.366203,
    },
    referencePriceUsd: 77.51,
    referenceSizeUsd: 4_619.22,
    requestedTakeProfitPrice: 77.54355974325433,
    minimumTakeProfitUsd: 3.5,
  });
  assert.equal(protection.targetNetProfitUsd, 3.5);
  assert.ok(protection.takeProfitPrice > 77.620217);
});

test("agent entries are always built without bundled TP/SL", () => {
  assert.deepEqual(getEntryPositionTpsl(), []);
});

test("live position lookup converts Jupiter raw USD values", () => {
  const position = parseActualPositionForProtection({
    side: "long",
    entryPriceUsd: "77492000",
    markPriceUsd: "77455397",
    sizeUsd: "4451980450",
    totalFeesUsd: "5366203",
  });
  assert.deepEqual(position, {
    side: "long",
    entryPriceUsd: 77.492,
    markPriceUsd: 77.455397,
    sizeUsd: 4_451.98045,
    totalFeesUsd: 5.366203,
  });
});
