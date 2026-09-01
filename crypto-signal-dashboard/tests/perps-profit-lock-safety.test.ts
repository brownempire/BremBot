import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateScalpProfitLockStopPrice,
  estimatePerpsPeakRoeFromCompletedCandles,
  evaluatePerpsProfitLock,
  SCALP_PROFIT_LOCK_MINIMUM_NET_ROE_PERCENT,
  SCALP_PROFIT_LOCK_RESCUE_ARM_ROE_PERCENT,
  SCALP_PROFIT_LOCK_RESCUE_EXIT_ROE_PERCENT,
} from "../lib/perps/profitLock";

test("long and short stop prices add the round-trip fee exactly once", () => {
  const entryPrice = 100;
  const feeRate = 0.00205;

  for (const leverage of [20, 49.9]) {
    for (const side of ["long", "short"] as const) {
      for (const exitNetRoePercent of [2, 7]) {
        const stopPrice = calculateScalpProfitLockStopPrice({
          side,
          entryPrice,
          leverage,
          exitNetRoePercent,
          estimatedRoundTripFeeRate: feeRate,
        });
        assert.notEqual(stopPrice, null);

        const direction = side === "long" ? 1 : -1;
        const impliedGrossRoePercent = direction
          * (((stopPrice ?? entryPrice) - entryPrice) / entryPrice)
          * leverage
          * 100;
        const impliedNetRoePercent = impliedGrossRoePercent - feeRate * leverage * 100;
        assert.ok(
          Math.abs(impliedNetRoePercent - exitNetRoePercent) < 0.00003,
          `${side} ${leverage}x stop implied ${impliedNetRoePercent}% net ROE`
        );
      }
    }
  }
});

test("completed-candle high water is converted to fee-adjusted net ROE", () => {
  const peak = estimatePerpsPeakRoeFromCompletedCandles({
    side: "long",
    entryPrice: 100,
    leverage: 20,
    currentRoePercent: 5,
    points: [{ t: 2_000, v: 100.4, h: 100.8, l: 99.9 }],
    since: 1_000,
    estimatedRoundTripFeeRate: 0.00205,
  });

  // 0.8% * 20x = 16% gross ROE; 4.1 points of conservative fees = 11.9% net.
  assert.equal(Number(peak.toFixed(6)), 11.9);
});

test("gross candle excursion below the fee-adjusted rescue arm cannot falsely arm the staircase", () => {
  const observedPeak = estimatePerpsPeakRoeFromCompletedCandles({
    side: "long",
    entryPrice: 100,
    leverage: 20,
    currentRoePercent: 3,
    points: [{ t: 2_000, v: 100.2, h: 100.39, l: 99.9 }],
    estimatedRoundTripFeeRate: 0.00205,
  });
  const result = evaluatePerpsProfitLock({
    positionPubkey: "position-1",
    currentRoePercent: 3,
    observedPeakRoePercent: observedPeak,
    previousState: null,
    strategyClass: "scalp",
    leverage: 20,
    estimatedRoundTripFeeRate: 0.00205,
    now: 3_000,
  });

  assert.equal(Number(observedPeak.toFixed(2)), 3.7);
  assert.equal(result.action, "track");
  assert.equal(result.activeTier, null);
});

test("scalp rescue tier arms at 4% net ROE and closes on a retreat to 2%", () => {
  const armed = evaluatePerpsProfitLock({
    positionPubkey: "rescue-position",
    currentRoePercent: 4,
    previousState: null,
    strategyClass: "scalp",
    now: 1_000,
  });
  assert.equal(SCALP_PROFIT_LOCK_RESCUE_ARM_ROE_PERCENT, 4);
  assert.equal(SCALP_PROFIT_LOCK_RESCUE_EXIT_ROE_PERCENT, 2);
  assert.equal(armed.action, "armed");
  assert.equal(armed.activeTier, "four-to-two");
  assert.equal(armed.exitRoePercent, 2);
  assert.equal(armed.state.protectedExitRoePercent, 2);

  const held = evaluatePerpsProfitLock({
    positionPubkey: "rescue-position",
    currentRoePercent: 3,
    previousState: armed.state,
    strategyClass: "scalp",
    now: 2_000,
  });
  assert.equal(held.action, "armed");
  assert.equal(held.activeTier, "four-to-two");

  const retreat = evaluatePerpsProfitLock({
    positionPubkey: "rescue-position",
    currentRoePercent: 2,
    previousState: held.state,
    strategyClass: "scalp",
    now: 3_000,
  });
  assert.equal(retreat.action, "close");
  assert.equal(retreat.activeTier, "four-to-two");
});

test("a completed-candle high can close a retreat that minute snapshots would miss", () => {
  const result = evaluatePerpsProfitLock({
    positionPubkey: "position-1",
    currentRoePercent: 6,
    observedPeakRoePercent: 11.9,
    previousState: null,
    strategyClass: "scalp",
    leverage: 20,
    estimatedRoundTripFeeRate: 0.00205,
    now: 3_000,
  });

  assert.equal(result.activeTier, "ten-to-seven");
  assert.equal(result.exitRoePercent, 7);
  assert.equal(result.action, "close");
});

test("net-ROE protection does not add round-trip fees a second time", () => {
  const first = evaluatePerpsProfitLock({
    positionPubkey: "position-1",
    currentRoePercent: 10,
    previousState: null,
    strategyClass: "scalp",
    leverage: 20,
    estimatedRoundTripFeeRate: 0.004,
    now: 1_000,
  });
  const persisted = evaluatePerpsProfitLock({
    positionPubkey: "position-1",
    currentRoePercent: 9.5,
    previousState: first.state,
    strategyClass: "scalp",
    leverage: 20,
    estimatedRoundTripFeeRate: 0.00205,
    now: 2_000,
  });

  assert.equal(SCALP_PROFIT_LOCK_MINIMUM_NET_ROE_PERCENT, 1);
  assert.equal(first.exitRoePercent, 7);
  assert.equal(first.state.protectedExitRoePercent, 7);
  assert.equal(persisted.exitRoePercent, 7);
});

test("legacy 49.9x positions do not close immediately when the first net-ROE tier arms", () => {
  const result = evaluatePerpsProfitLock({
    positionPubkey: "legacy-position",
    currentRoePercent: 10,
    previousState: null,
    strategyClass: "scalp",
    leverage: 49.9,
    estimatedRoundTripFeeRate: 0.00205,
    now: 1_000,
  });

  assert.equal(result.activeTier, "ten-to-seven");
  assert.equal(result.exitRoePercent, 7);
  assert.equal(result.action, "armed");
});
