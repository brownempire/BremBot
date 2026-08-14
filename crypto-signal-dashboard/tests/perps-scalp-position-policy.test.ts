import assert from "node:assert/strict";
import test from "node:test";

import type { JupiterPerpsPosition } from "../lib/jupiterPerps";
import {
  evaluateScalpPositionPolicy,
  SCALP_MAX_CONCURRENT_POSITIONS,
  SCALP_REVERSAL_MINIMUM_PROJECTED_SURPLUS_USD,
} from "../lib/perps/scalpPositionPolicy";

function position(side: "long" | "short", unrealizedPnl: number, accountRef = `position-${side}`): JupiterPerpsPosition {
  return {
    id: accountRef,
    source: "live-api",
    platformId: "jupiter-exchange",
    marketSymbol: "SOL",
    marketName: "Solana Perps",
    marketAddress: "market",
    custodyAddress: "custody",
    collateralCustodyAddress: "collateral",
    collateralSymbol: "USDC",
    imageUri: null,
    side,
    entryPrice: 100,
    markPrice: 100,
    positionSize: 6,
    positionValue: 600,
    collateralValue: 12,
    leverage: 50,
    unrealizedPnl,
    realizedPnl: 0,
    liquidationPrice: side === "long" ? 98 : 102,
    fundingSnapshot: null,
    borrowSnapshot: null,
    takeProfit: side === "long" ? 101 : 99,
    stopLoss: side === "long" ? 99 : 101,
    markPriceIsLive: true,
    liquidationPriceIsEstimated: false,
    accountRef,
    lastUpdated: Date.now(),
  };
}

const exceptionalLong = {
  candidateSide: "long" as const,
  setupType: "liquidity-sweep" as const,
  confidence: 0.89,
  priceActionScore: 0.96,
  indicatorBypass: true,
  projectedNetProfitUsd: 4.5,
};

test("scalp policy keeps same-side entries separate by refusing a Jupiter merge", () => {
  const decision = evaluateScalpPositionPolicy({
    openPositions: [position("long", 1)],
    ...exceptionalLong,
  });

  assert.equal(decision.action, "block");
  if (decision.action === "block") assert.equal(decision.code, "SAME_SIDE_POSITION_OPEN");
});

test("a qualifying opposite scalp can coexist with one independently managed position", () => {
  const decision = evaluateScalpPositionPolicy({
    openPositions: [position("short", 1)],
    ...exceptionalLong,
    indicatorBypass: false,
  });

  assert.equal(decision.action, "hold-concurrent");
  assert.equal(SCALP_MAX_CONCURRENT_POSITIONS, 2);
});

test("exceptional opposite scalp reverses only when projected post-fee profit covers the loss and buffer", () => {
  const reversal = evaluateScalpPositionPolicy({
    openPositions: [position("short", -1.5)],
    ...exceptionalLong,
  });
  assert.equal(reversal.action, "reverse");
  if (reversal.action === "reverse") {
    assert.ok(reversal.projectedSurplusUsd >= SCALP_REVERSAL_MINIMUM_PROJECTED_SURPLUS_USD);
  }

  const insufficientRecovery = evaluateScalpPositionPolicy({
    openPositions: [position("short", -4)],
    ...exceptionalLong,
  });
  assert.equal(insufficientRecovery.action, "hold-concurrent");
});

test("two open scalp positions cap further concurrent exposure", () => {
  const decision = evaluateScalpPositionPolicy({
    openPositions: [position("short", 1), position("long", 1)],
    ...exceptionalLong,
    candidateSide: "long",
  });

  assert.equal(decision.action, "block");
});
