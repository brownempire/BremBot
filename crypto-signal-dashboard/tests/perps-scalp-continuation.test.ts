import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  detectAdaptiveScalpSignal,
  evaluateScalpTrendContinuation,
  type ScalpPriceAction,
} from "../lib/perps/scalpEngine";
import type { PricePoint } from "../lib/price/simulated";
import type { IndicatorSnapshot } from "../lib/signal/indicators";

const confirmedBullishPriceAction: ScalpPriceAction = {
  direction: "bullish",
  setupType: "v-reversal",
  score: 0.58,
  strong: false,
  confirmed: true,
  tags: ["PRICE_RECLAIM", "PRICE_MOMENTUM_TURN", "PRICE_VOLUME_CONFIRMATION"],
  sweepPercent: 0,
  reclaimPercent: 0.2,
};

const confirmedBullishIndicators: IndicatorSnapshot = {
  emaFast: 100.1,
  emaSlow: 100,
  emaSpreadPercent: 0.1,
  emaSlopePercent: 0.05,
  rsi: 68,
  macdLine: 0.1,
  macdSignal: 0.08,
  macdHistogram: 0.02,
  macdHistogramChange: 0.01,
  adx: 30,
  plusDi: 29,
  minusDi: 14,
  atrPercent: 0.12,
  volumeRatio: 1.2,
  bollingerBandwidthPercent: 0.7,
  bollingerPosition: 0.7,
};

function continuationCandles(): PricePoint[] {
  const start = 1_785_600_000_000;
  const closes = [98.8, ...Array<number>(16).fill(100), 100, 99.95, 99.9, 99.8, 99.88, 99.94, 100.02];
  return closes.map((close, index) => ({
    t: start + index * 60_000,
    o: index === 21 ? 99.82 : close - 0.01,
    h: index === 21 ? 99.89 : close + 0.02,
    l: index === 21 ? 99.75 : close - 0.02,
    v: close,
    volume: index >= 22 ? 130 : 100,
  }));
}

test("the balanced scalp profile opens its price-action gate at 0.58", () => {
  assert.equal(DEFAULT_SCALP_LEARNING_PROFILE.minimumPriceActionScore, 0.58);

  const belowFloor = evaluateScalpTrendContinuation({
    priceAction: { ...confirmedBullishPriceAction, score: 0.42 },
    trendBias: "bullish",
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });
  assert.equal(belowFloor.qualified, false);
  assert.match(belowFloor.reasons[0] ?? "", /0\.42 is below 0\.58/);

  const atFloor = evaluateScalpTrendContinuation({
    priceAction: confirmedBullishPriceAction,
    trendBias: "bullish",
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });
  assert.deepEqual(atFloor, { qualified: true, reasons: [] });
});

test("continuation entries still require balanced trend, momentum, volatility, and volume", () => {
  for (const [field, value, expectedReason] of [
    ["rsi", 92, /RSI/],
    ["adx", 54.3, /ADX/],
    ["volumeRatio", 1.1, /Volume/],
    ["atrPercent", 0.08, /ATR/],
  ] as const) {
    const result = evaluateScalpTrendContinuation({
      priceAction: confirmedBullishPriceAction,
      trendBias: "bullish",
      indicators: { ...confirmedBullishIndicators, [field]: value },
      profile: DEFAULT_SCALP_LEARNING_PROFILE,
    });
    assert.equal(result.qualified, false, `${field} should block the continuation entry`);
    assert.match(result.reasons.join(" "), expectedReason);
  }
});

test("a qualifying 0.58+ continuation becomes a scalp signal and an overheated move does not", () => {
  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points: continuationCandles(),
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });

  assert.ok(signal);
  assert.equal(signal.type, "scalp");
  assert.equal(signal.direction, "bullish");
  assert.ok(signal.priceActionScore >= 0.58);
  assert.ok(signal.priceActionTags.includes("INDICATORS_CONFIRMED_TREND_CONTINUATION"));

  const overheated = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points: continuationCandles(),
    indicators: { ...confirmedBullishIndicators, rsi: 92 },
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });
  assert.equal(overheated, null);
});
