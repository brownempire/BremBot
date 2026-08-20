import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED,
  evaluateScalpReversalSafety,
  type ScalpPriceAction,
} from "../lib/perps/scalpEngine";
import type { IndicatorSnapshot } from "../lib/signal/indicators";

function priceAction(direction: "bullish" | "bearish", score: number, confirmed: boolean): ScalpPriceAction {
  return {
    direction,
    setupType: "liquidity-sweep",
    score,
    strong: score >= 0.856,
    confirmed,
    tags: ["PRICE_LIQUIDITY_SWEEP_RECLAIM", "PRICE_RECLAIM", "PRICE_MOMENTUM_TURN"],
    sweepPercent: 0.1,
    reclaimPercent: 0.2,
  };
}

const baseIndicators: IndicatorSnapshot = {
  emaFast: 100.1,
  emaSlow: 100,
  emaSpreadPercent: 0.1,
  emaSlopePercent: 0.02,
  rsi: 60,
  macdLine: 0.1,
  macdSignal: 0.08,
  macdHistogram: 0.02,
  macdHistogramChange: 0.01,
  adx: 35,
  plusDi: 28,
  minusDi: 16,
  atrPercent: 0.12,
  volumeRatio: 1.1,
  bollingerBandwidthPercent: 0.7,
  bollingerPosition: 0.6,
};

test("the live exceptional-reversal bypass is explicitly paused", () => {
  assert.equal(SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED, false);
});

test("today's losing long is rejected by persistence, volume, and directional contradiction", () => {
  const result = evaluateScalpReversalSafety({
    priceAction: priceAction("bullish", 1, true),
    previousPriceAction: priceAction("bullish", 1, false),
    indicators: {
      ...baseIndicators,
      emaFast: 81.45,
      emaSlow: 81.54,
      emaSpreadPercent: -0.1096,
      rsi: 43.04,
      adx: 43.58,
      plusDi: 15.32,
      minusDi: 33.06,
      volumeRatio: 0.0064,
    },
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });

  assert.equal(result.qualified, false);
  assert.match(result.reasons.join(" "), /two completed candles/);
  assert.match(result.reasons.join(" "), /volume/i);
  assert.match(result.reasons.join(" "), /both oppose/i);
});

test("today's losing short is rejected by persistence, ADX, volume, and bullish contradiction", () => {
  const result = evaluateScalpReversalSafety({
    priceAction: priceAction("bearish", 0.96, true),
    previousPriceAction: priceAction("bearish", 0.76, false),
    indicators: {
      ...baseIndicators,
      emaFast: 82.08,
      emaSlow: 81.97,
      emaSpreadPercent: 0.1338,
      rsi: 67.8,
      adx: 67.28,
      plusDi: 32.85,
      minusDi: 11.68,
      volumeRatio: 0.1071,
    },
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });

  assert.equal(result.qualified, false);
  assert.match(result.reasons.join(" "), /two completed candles/);
  assert.match(result.reasons.join(" "), /ADX/);
  assert.match(result.reasons.join(" "), /volume/i);
  assert.match(result.reasons.join(" "), /both oppose/i);
});

test("the third pre-v7 short loss is rejected because bullish EMA/DMI and thin volume oppose it", () => {
  const result = evaluateScalpReversalSafety({
    priceAction: priceAction("bearish", 0.94, true),
    previousPriceAction: priceAction("bearish", 0.7, false),
    indicators: {
      ...baseIndicators,
      emaFast: 82.3,
      emaSlow: 82.18,
      emaSpreadPercent: 0.146,
      emaSlopePercent: 0.08,
      rsi: 66,
      plusDi: 31,
      minusDi: 13,
      volumeRatio: 0.125,
    },
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });

  assert.equal(result.qualified, false);
  assert.match(result.reasons.join(" "), /two completed candles/);
  assert.match(result.reasons.join(" "), /volume/i);
  assert.match(result.reasons.join(" "), /both oppose/i);
});

test("a persisted, liquid, directionally confirmed reversal can pass safety diagnostics", () => {
  const current = priceAction("bullish", 0.82, true);
  const result = evaluateScalpReversalSafety({
    priceAction: current,
    previousPriceAction: { ...current, score: 0.7 },
    indicators: baseIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });

  assert.deepEqual(result, { qualified: true, reasons: [] });
});

test("v and double pseudo-reversals cannot use the live reversal path without a defined-level sweep", () => {
  for (const setupType of ["v-reversal", "double-reversal"] as const) {
    const current = { ...priceAction("bullish", 0.9, true), setupType };
    const result = evaluateScalpReversalSafety({
      priceAction: current,
      previousPriceAction: current,
      indicators: baseIndicators,
      profile: DEFAULT_SCALP_LEARNING_PROFILE,
    });

    assert.equal(result.qualified, false);
    assert.match(result.reasons.join(" "), /defined-level liquidity sweep/);
  }
});
