import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTradeDecision } from "../lib/decision/engine";
import type { TradeDecisionPayload } from "../lib/decision/types";

function continuationPayload(overrides: Partial<TradeDecisionPayload> = {}): TradeDecisionPayload {
  const payload: TradeDecisionPayload = {
    decisionId: "decision-scalp-veto",
    createdAt: new Date().toISOString(),
    walletAddress: "wallet-scalp-veto",
    sessionId: "session-scalp-veto",
    sessionMode: "live",
    executionModel: "delegated-ready",
    signalId: "signal-scalp-veto",
    symbol: "SOL/USD",
    summary: "Confirmed continuation",
    direction: "bullish",
    signalConfidence: 0.86,
    asset: "SOL",
    strategyClass: "scalp",
    requestedTrade: {
      collateralUsd: 20,
      leverage: 20,
      takeProfitPrice: 101.5,
      stopLossPrice: 99.5,
      maxSlippageBps: 100,
      executionStyle: "set-parameters",
      smartTradeProfile: null,
    },
    marketContext: {
      spotPrice: 100,
      volatilityPercent: 1.2,
      trendBias: "bullish",
      availableUsdc: 100,
      hasOpenPosition: false,
      allowConcurrentPosition: false,
      recentPriceChangePercent: 0.4,
    },
    strategyContext: {
      signalType: "scalp",
      trendWindow: 145,
      trendThreshold: 0,
      breakoutPercent: 0,
      cooldownSeconds: 2_550,
      trendStrengthPercent: 0.4,
      breakoutStrengthPercent: 0.2,
      atrPercent: 0.15,
      scalpSetupType: "v-reversal",
      priceActionScore: 0.78,
      priceActionTags: [
        "INDICATORS_CONFIRMED_TREND_CONTINUATION",
        "CONTINUATION_TWO_CANDLE_CONFIRMATION",
        "CONTINUATION_PULLBACK_RETEST_RESUMPTION",
        "CONTINUATION_MACD_CONFIRMED",
        "SCALP_EXHAUSTION_GUARD_PASSED",
      ],
      indicatorBypass: false,
      indicators: {
        emaSpreadPercent: 0.08,
        emaSlopePercent: 0.05,
        rsi: 62,
        macdLine: 0.2,
        macdSignal: 0.1,
        macdHistogram: 0.1,
        macdHistogramChange: 0.04,
        adx: 28,
        plusDi: 31,
        minusDi: 15,
        volumeRatio: 1.4,
        bollingerBandwidthPercent: 0.8,
        bollingerPosition: 0.65,
      },
      learningProfileId: null,
    },
    historyContext: {
      recentExecutionCount: 0,
      approvalRequiredCount: 0,
      submittedCount: 0,
      confirmedCount: 0,
      paperExecutedCount: 0,
      blockedCount: 0,
      failedCount: 0,
      recentFailureRate: 0,
      recentBlockedRate: 0,
    },
    shadowMode: false,
  };
  return { ...payload, ...overrides };
}

test("independent scalp veto accepts a fully confirmed, aligned continuation", () => {
  const result = evaluateTradeDecision(continuationPayload());

  assert.equal(result.shouldTrade, true);
  assert.equal(result.riskGrade, "medium");
  assert.ok(result.explanationTags.includes("scalp-independent-veto"));
  assert.ok(result.explanationTags.includes("scalp-path-continuation"));
});

test("independent scalp veto rejects continuation without two-candle persistence", () => {
  const payload = continuationPayload();
  payload.strategyContext!.priceActionTags = payload.strategyContext!.priceActionTags!
    .filter((tag) => tag !== "CONTINUATION_TWO_CANDLE_CONFIRMATION");

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-setup-confirmation-required"));
});

test("independent scalp veto rejects raw indicators that contradict the direction", () => {
  const payload = continuationPayload();
  payload.strategyContext!.indicators = {
    ...payload.strategyContext!.indicators!,
    emaSpreadPercent: -0.08,
    emaSlopePercent: -0.05,
    macdHistogram: -0.1,
    macdHistogramChange: -0.04,
    plusDi: 12,
    minusDi: 34,
  };

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-directional-indicator-veto"));
});

test("independent scalp veto rejects exhausted volatility and excessive leverage", () => {
  const payload = continuationPayload({
    requestedTrade: {
      ...continuationPayload().requestedTrade,
      leverage: 50,
    },
    marketContext: {
      ...continuationPayload().marketContext,
      volatilityPercent: 5.3,
    },
  });

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-leverage-cap-veto"));
  assert.ok(result.explanationTags.includes("scalp-volatility-veto"));
});

test("independent scalp veto rejects exits with poor reward-to-risk after fees", () => {
  const payload = continuationPayload({
    requestedTrade: {
      ...continuationPayload().requestedTrade,
      takeProfitPrice: 100.5,
      stopLossPrice: 99.5,
    },
  });

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-post-fee-economics-veto"));
});

test("independent scalp veto uses the rolling conservative fee estimate", () => {
  const payload = continuationPayload();
  payload.strategyContext = {
    ...payload.strategyContext!,
    estimatedRoundTripFeeRate: 0.005,
  };

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-post-fee-economics-veto"));
});

test("independent scalp veto accepts a statefully confirmed range reversal", () => {
  const payload = continuationPayload();
  payload.strategyContext = {
    ...payload.strategyContext!,
    scalpSetupType: "range-reversal",
    priceActionScore: 0.76,
    priceActionTags: [
      "SCALP_RANGE",
      "SCALP_RANGE_LOW",
      "RANGE_EXTREME_OBSERVED",
      "RANGE_BAND_REENTRY",
      "RANGE_RSI_MACD_TURN",
      "RANGE_CONFIRMING_CANDLE",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ],
  };

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, true);
  assert.ok(result.explanationTags.includes("scalp-path-range-reversal"));
});

test("independent scalp veto mirrors the breakout/retest ATR floor", () => {
  const payload = continuationPayload();
  payload.strategyContext = {
    ...payload.strategyContext!,
    scalpEntryPath: "breakout-retest",
    priceActionScore: 0.75,
    priceActionTags: [
      "PRICE_BREAKOUT",
      "PRICE_BREAKOUT_RETEST",
      "PRICE_BREAKOUT_RESUMPTION",
      "INDICATORS_CONFIRMED_BREAKOUT_RETEST",
      "BREAKOUT_ATR_CONFIRMED",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ],
    indicators: {
      ...payload.strategyContext!.indicators!,
      atrPercent: 0.089,
    },
  };

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-directional-indicator-veto"));
});
