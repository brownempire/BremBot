import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  SCALP_BASIC_REVERSAL_MIN_PRICE_ACTION_SCORE,
  SCALP_BREAKOUT_RETEST_MIN_PRICE_ACTION_SCORE,
  SCALP_CONTINUATION_MIN_PRICE_ACTION_SCORE,
  SCALP_CONTINUATION_STANDARD_PRICE_ACTION_SCORE,
  SCALP_CONTINUATION_LIVE_ENABLED,
  SCALP_EXHAUSTION_BLOCK_ENABLED,
  SCALP_RANGE_REVERSAL_LIVE_ENABLED,
  SCALP_RANGE_REVERSAL_SIGNAL_CONFIDENCE,
  SCALP_EXCEPTIONAL_REVERSAL_SCORE,
  SCALP_STRONG_REVERSAL_SCORE,
  SCALP_REVERSAL_LIVE_ENABLED,
  SCALP_MAX_145M_NET_OR_RANGE_PERCENT,
  classifyScalpMarketRegime,
  detectAdaptiveScalpSignal,
  evaluateAdaptiveScalpCandidate,
  evaluateScalpBreakoutRetest,
  evaluateScalpRangeReversal,
  evaluateScalpTrendContinuation,
  normalizeScalpLearningProfileForLiveOperation,
  scalpCandidatePathAllowsLiveSignal,
  type ScalpMarketRegime,
  type ScalpPriceAction,
} from "../lib/perps/scalpEngine";
import type { PricePoint } from "../lib/price/simulated";
import type { IndicatorSnapshot } from "../lib/signal/indicators";

const confirmedBullishPriceAction: ScalpPriceAction = {
  direction: "bullish",
  setupType: "v-reversal",
  score: 0.76,
  strong: false,
  confirmed: true,
  tags: ["PRICE_RECLAIM", "PRICE_MOMENTUM_TURN", "PRICE_VOLUME_CONFIRMATION"],
  sweepPercent: 0,
  reclaimPercent: 0.2,
};

const confirmedBullishIndicators: IndicatorSnapshot = {
  emaFast: 100.04,
  emaSlow: 99.98,
  emaSpreadPercent: 0.06,
  emaSlopePercent: 0.04,
  rsi: 68,
  macdLine: 0.1,
  macdSignal: 0.08,
  macdHistogram: 0.02,
  macdHistogramChange: 0.01,
  adx: 30,
  plusDi: 29,
  minusDi: 14,
  atrPercent: 0.3,
  volumeRatio: 1.2,
  bollingerBandwidthPercent: 0.7,
  bollingerPosition: 0.7,
};

const bullishRegime: ScalpMarketRegime = {
  bias: "bullish",
  trending: true,
  exhausted: false,
  netMove145mPercent: 0.8,
  range145mPercent: 1.2,
  horizons: [],
};

function candlesFromCloses(closes: number[], start = 1_785_600_000_000): PricePoint[] {
  return closes.map((close, index) => ({
    t: start + index * 60_000,
    o: index === 0 ? close : closes[index - 1],
    h: close + 0.025,
    l: close - 0.025,
    v: close,
    volume: index >= closes.length - 3 ? 130 : 100,
  }));
}

function pullbackRetestCandles(): PricePoint[] {
  return candlesFromCloses([
    99.7, 99.78, 99.84, 99.9, 99.96, 100.02, 100.08, 100.15,
    100.2, 100.14, 100.09, 100.04, 100.03, 100.06, 100.1, 100.15,
  ]);
}

function trendingCandles(netMovePercent: number): PricePoint[] {
  return candlesFromCloses(Array.from({ length: 145 }, (_, index) => (
    100 * (1 + netMovePercent / 100 * index / 144)
  )));
}

function breakoutRetestCandles(): PricePoint[] {
  const closes = Array.from({ length: 51 }, (_, index) => 100 + Math.sin(index / 2) * 0.025);
  closes.push(100.15, 100.14, 100.09, 100.11, 100.13, 100.14, 100.12, 100.16, 100.2);
  return candlesFromCloses(closes).map((point, index) => ({
    ...point,
    h: index < 51 ? Math.min(point.h!, 100.08) : point.h,
    l: index === 53 ? 100.055 : point.l,
    volume: index === 51 ? 220 : point.volume,
  }));
}

function rangeReentryCandles(): PricePoint[] {
  const closes = [
    ...Array.from({ length: 50 }, (_, index) => 100 + Math.sin(index) * 0.015),
    99.96, 99.88, 99.78, 99.68, 99.64, 99.72, 99.8, 99.88, 99.94, 100,
  ];
  return candlesFromCloses(closes);
}

test("multi-horizon regime classification recognizes a 0.62% move instead of calling it sideways", () => {
  const points = candlesFromCloses(Array.from({ length: 80 }, (_, index) => (
    100 + 0.62 * index / 79
  )));
  const regime = classifyScalpMarketRegime(points);

  assert.equal(regime.bias, "bullish");
  assert.equal(regime.trending, true);
  assert.deepEqual(regime.horizons.map((horizon) => horizon.minutes), [5, 15, 60]);
  assert.ok(regime.horizons.every((horizon) => horizon.atrPercent > 0));
});

test("operator-selected scalp score rails are active", () => {
  assert.equal(SCALP_BASIC_REVERSAL_MIN_PRICE_ACTION_SCORE, 0.58);
  assert.equal(DEFAULT_SCALP_LEARNING_PROFILE.minimumPriceActionScore, 0.58);
  assert.equal(SCALP_CONTINUATION_MIN_PRICE_ACTION_SCORE, 0.6);
  assert.equal(SCALP_CONTINUATION_STANDARD_PRICE_ACTION_SCORE, 0.68);
  assert.equal(SCALP_STRONG_REVERSAL_SCORE, 0.77);
  assert.equal(DEFAULT_SCALP_LEARNING_PROFILE.strongReversalScore, 0.77);
  assert.equal(SCALP_EXCEPTIONAL_REVERSAL_SCORE, 0.88);
  assert.equal(SCALP_BREAKOUT_RETEST_MIN_PRICE_ACTION_SCORE, 0.68);

  const belowFloor = evaluateScalpTrendContinuation({
    priceAction: { ...confirmedBullishPriceAction, score: 0.59 },
    previousPriceAction: confirmedBullishPriceAction,
    points: pullbackRetestCandles(),
    trendBias: "bullish",
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: bullishRegime,
  });
  assert.equal(belowFloor.qualified, false);
  assert.match(belowFloor.reasons.join(" "), /0\.59 is below.*0\.60/);

  const improvingCandidate = evaluateScalpTrendContinuation({
    priceAction: { ...confirmedBullishPriceAction, score: 0.6 },
    previousPriceAction: { ...confirmedBullishPriceAction, score: 0.58 },
    points: pullbackRetestCandles(),
    trendBias: "bullish",
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: bullishRegime,
  });
  assert.equal(improvingCandidate.qualified, true);
  assert.equal(evaluateScalpTrendContinuation({
    priceAction: { ...confirmedBullishPriceAction, score: 0.6 },
    previousPriceAction: { ...confirmedBullishPriceAction, score: 0.58 },
    points: pullbackRetestCandles(),
    trendBias: "bullish",
    indicators: confirmedBullishIndicators,
    profile: { ...DEFAULT_SCALP_LEARNING_PROFILE, minimumPriceActionScore: 0.8 },
    regime: bullishRegime,
  }).qualified, true, "the learned reversal score must not silently raise the continuation floor");

  const unconfirmedPriorCandleIsReplacedByLiveConfirmation = evaluateScalpTrendContinuation({
    priceAction: confirmedBullishPriceAction,
    previousPriceAction: { ...confirmedBullishPriceAction, confirmed: false },
    points: pullbackRetestCandles(),
    trendBias: "bullish",
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: bullishRegime,
  });
  assert.equal(unconfirmedPriorCandleIsReplacedByLiveConfirmation.qualified, true);
});

test("every independently confirmed scalp path is authorized for live routing", () => {
  assert.equal(SCALP_CONTINUATION_LIVE_ENABLED, true);
  assert.equal(SCALP_RANGE_REVERSAL_LIVE_ENABLED, true);
  assert.equal(SCALP_REVERSAL_LIVE_ENABLED, true);
  assert.equal(scalpCandidatePathAllowsLiveSignal("continuation"), true);
  assert.equal(scalpCandidatePathAllowsLiveSignal("breakout-retest"), true);
  assert.equal(scalpCandidatePathAllowsLiveSignal("reversal"), true);
  assert.equal(scalpCandidatePathAllowsLiveSignal("range-reversal"), true);
  assert.equal(SCALP_EXHAUSTION_BLOCK_ENABLED, false);
});

test("a continuation uses three-of-four indicator consensus plus hard structural safety", () => {
  const evaluate = (indicators: IndicatorSnapshot, points = pullbackRetestCandles()) => evaluateScalpTrendContinuation({
    priceAction: confirmedBullishPriceAction,
    previousPriceAction: confirmedBullishPriceAction,
    points,
    trendBias: "bullish",
    indicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: bullishRegime,
  });

  const fullyConfirmed = evaluate(confirmedBullishIndicators);
  assert.equal(fullyConfirmed.qualified, true);
  assert.equal(fullyConfirmed.confirmationGroupsPassed, 4);
  assert.deepEqual(fullyConfirmed.reasons, []);
  const wideRegime = evaluateScalpTrendContinuation({
    priceAction: confirmedBullishPriceAction,
    previousPriceAction: confirmedBullishPriceAction,
    points: pullbackRetestCandles(),
    trendBias: "bullish",
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: { ...bullishRegime, exhausted: true, range145mPercent: 5.3 },
  });
  assert.equal(wideRegime.qualified, true);
  assert.equal(evaluate({ ...confirmedBullishIndicators, plusDi: 10, minusDi: 30 }).qualified, true);
  assert.equal(evaluate({ ...confirmedBullishIndicators, macdHistogramChange: -0.01 }).qualified, true);
  assert.equal(evaluate({ ...confirmedBullishIndicators, bollingerPosition: 0.721 }).qualified, true);
  const insufficientConsensus = evaluate({
    ...confirmedBullishIndicators,
    plusDi: 10,
    minusDi: 30,
    macdHistogramChange: -0.01,
  });
  assert.equal(insufficientConsensus.qualified, false);
  assert.match(insufficientConsensus.reasons.join(" "), /2 of 4 groups/);
  const materiallyOpposed = evaluate({
    ...confirmedBullishIndicators,
    emaFast: 99.8,
    emaSlow: 100,
    plusDi: 10,
    minusDi: 30,
  });
  assert.equal(materiallyOpposed.qualified, false);
  assert.match(materiallyOpposed.reasons.join(" "), /materially oppose/);
  assert.match(evaluate(confirmedBullishIndicators, candlesFromCloses(Array.from({ length: 16 }, (_, index) => 100 + index * 0.03))).reasons.join(" "), /pullback/);
});

test("the two post-v7 losing continuations remain blocked by missing pullback structure", () => {
  for (const [score, netMove] of [[0.62, 5.7], [0.6, 3.44]] as const) {
    const points = trendingCandles(netMove);
    const regime = classifyScalpMarketRegime(points);
    const evaluation = evaluateScalpTrendContinuation({
      priceAction: { ...confirmedBullishPriceAction, score },
      previousPriceAction: { ...confirmedBullishPriceAction, score, confirmed: false },
      points,
      trendBias: "bullish",
      indicators: confirmedBullishIndicators,
      profile: DEFAULT_SCALP_LEARNING_PROFILE,
      regime,
    });

    assert.equal(regime.exhausted, true);
    assert.ok(regime.netMove145mPercent > SCALP_MAX_145M_NET_OR_RANGE_PERCENT);
    assert.equal(evaluation.qualified, false);
    assert.match(evaluation.reasons.join(" "), /pullback/i);
    assert.doesNotMatch(evaluation.reasons.join(" "), /two completed candles/);
    assert.doesNotMatch(evaluation.reasons.join(" "), /exhaustion/);
  }
});

test("candidate diagnostics retain the high-volatility regime without using it as a blanket veto", () => {
  const points = trendingCandles(5.7);
  const evaluation = evaluateAdaptiveScalpCandidate({
    symbol: "SOL/USD",
    points,
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });

  assert.equal(evaluation.signal, null);
  assert.equal(evaluation.candidate.accepted, false);
  assert.equal(evaluation.candidate.entryPrice, points.at(-1)!.v);
  assert.equal(evaluation.candidate.timestamp, points.at(-1)!.t);
  assert.equal(evaluation.candidate.regime.exhausted, true);
  assert.ok(evaluation.candidate.rejectionReasons.length > 0);
  assert.ok(evaluation.candidate.rejectionReasons.every((reason) => !/exhaustion|2%/.test(reason)));
});

test("a genuine breakout, retest, and resumption emits an independently tagged scalp signal", () => {
  const points = breakoutRetestCandles();
  const regime: ScalpMarketRegime = { ...bullishRegime, netMove145mPercent: 0.2, range145mPercent: 0.4 };
  const structural = evaluateScalpBreakoutRetest({ points, indicators: confirmedBullishIndicators, regime });

  assert.equal(structural.qualified, true);
  assert.equal(structural.direction, "bullish");
  assert.ok(structural.tags.includes("PRICE_BREAKOUT_RETEST"));
  assert.ok(structural.tags.includes("BREAKOUT_ATR_CONFIRMED"));
  assert.ok(structural.score >= 0.68 && structural.score <= 0.86);
  const wideRangeStructural = evaluateScalpBreakoutRetest({
    points,
    indicators: confirmedBullishIndicators,
    regime: { ...regime, exhausted: true, range145mPercent: 5.3 },
  });
  assert.equal(wideRangeStructural.qualified, true);
  const thinAtr = evaluateScalpBreakoutRetest({
    points,
    indicators: { ...confirmedBullishIndicators, atrPercent: 0.089 },
    regime,
  });
  assert.equal(thinAtr.qualified, false);
  assert.match(thinAtr.reasons.join(" "), /0\.09%/);

  const signal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: confirmedBullishIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
  });
  assert.ok(signal);
  assert.equal(signal.direction, "bullish");
  assert.ok(signal.priceActionTags.includes("INDICATORS_CONFIRMED_BREAKOUT_RETEST"));

  const missingVolume = evaluateScalpBreakoutRetest({
    points: points.map(({ volume: _volume, ...point }) => point),
    indicators: { ...confirmedBullishIndicators, volumeRatio: null },
    regime: bullishRegime,
  });
  assert.equal(missingVolume.qualified, false, "breakout execution fails closed without relative-volume evidence");
});

test("range reversal is a completed state machine, not a one-candle synthetic score", () => {
  const points = rangeReentryCandles();
  const sidewaysRegime: ScalpMarketRegime = {
    bias: "sideways",
    trending: false,
    exhausted: false,
    netMove145mPercent: 0,
    range145mPercent: 0.5,
    horizons: [],
  };
  const rangeIndicators: IndicatorSnapshot = {
    ...confirmedBullishIndicators,
    emaFast: 99.9,
    emaSlow: 99.89,
    emaSpreadPercent: 0.01,
    emaSlopePercent: 0.02,
    rsi: 52,
    macdHistogram: 0.02,
    macdHistogramChange: 0.01,
    adx: 12,
    volumeRatio: 1.2,
    bollingerPosition: 0.55,
  };
  const evaluation = evaluateScalpRangeReversal({
    points,
    indicators: rangeIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: sidewaysRegime,
  });

  assert.equal(evaluation.qualified, true);
  assert.equal(evaluation.score, 1, "the score records completion of every observable state, not estimated extremity");
  assert.ok(evaluation.tags.includes("RANGE_EXTREME_OBSERVED"));
  assert.ok(evaluation.tags.includes("RANGE_BAND_REENTRY"));
  assert.ok(evaluation.tags.includes("RANGE_RSI_MACD_TURN"));
  assert.ok(evaluation.tags.includes("RANGE_CONFIRMING_CANDLE"));

  const previouslyUnreachableProfile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  previouslyUnreachableProfile.minimumConfidence = 0.816;
  previouslyUnreachableProfile.setupConfidenceAdjustments.rangeReversal = 0.15;
  const operationalProfile = normalizeScalpLearningProfileForLiveOperation(previouslyUnreachableProfile);
  assert.ok(
    operationalProfile.minimumConfidence + operationalProfile.setupConfidenceAdjustments.rangeReversal
      <= SCALP_RANGE_REVERSAL_SIGNAL_CONFIDENCE,
    "learning must never raise the range-entry requirement above its emitted confidence"
  );
  const learnedSignal = detectAdaptiveScalpSignal({
    symbol: "SOL/USD",
    points,
    indicators: rangeIndicators,
    profile: operationalProfile,
  });
  assert.equal(learnedSignal?.setupType, "range-reversal");

  const wideRangeEvaluation = evaluateScalpRangeReversal({
    points,
    indicators: rangeIndicators,
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: { ...sidewaysRegime, exhausted: true, range145mPercent: 5.3 },
  });
  assert.equal(wideRangeEvaluation.qualified, true);

  const missingVolume = evaluateScalpRangeReversal({
    points,
    indicators: { ...rangeIndicators, volumeRatio: null },
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: sidewaysRegime,
  });
  assert.equal(missingVolume.qualified, false, "range execution fails closed without relative-volume evidence");

  const premature = evaluateScalpRangeReversal({
    points: points.slice(0, -5),
    indicators: { ...rangeIndicators, rsi: 25, macdHistogram: -0.02, macdHistogramChange: -0.01 },
    profile: DEFAULT_SCALP_LEARNING_PROFILE,
    regime: sidewaysRegime,
  });
  assert.equal(premature.qualified, false);
});
