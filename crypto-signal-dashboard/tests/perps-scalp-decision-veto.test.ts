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
      leverage: 25,
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
      cooldownSeconds: 420,
      trendStrengthPercent: 0.4,
      breakoutStrengthPercent: 0.2,
      atrPercent: 0.15,
      scalpPolicyVersion: 8,
      scalpSetupType: "v-reversal",
      priceActionScore: 0.78,
      priceActionTags: [
        "INDICATORS_CONFIRMED_TREND_CONTINUATION",
        "SIGNAL_CANDLE_CONFIRMED",
        "ONE_CANDLE_CANDIDATE_CONFIRMED",
        "LIVE_ENTRY_PRICE_VALIDATED",
        "CONTINUATION_PULLBACK_RETEST_RESUMPTION",
        "CONTINUATION_CONFIRMATION_CONSENSUS",
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

test("independent scalp veto rejects continuation without immediate live-entry validation", () => {
  const payload = continuationPayload();
  payload.strategyContext!.priceActionTags = payload.strategyContext!.priceActionTags!
    .filter((tag) => tag !== "LIVE_ENTRY_PRICE_VALIDATED");

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-setup-confirmation-required"));
});

test("authoritative scalp metadata is not re-vetoed by a duplicate indicator pass", () => {
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

  assert.equal(result.shouldTrade, true);
  assert.equal(result.explanationTags.includes("scalp-directional-indicator-veto"), false);
});

test("independent scalp veto requires the current detector policy version", () => {
  const payload = continuationPayload();
  delete payload.strategyContext!.scalpPolicyVersion;

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, false);
  assert.ok(result.explanationTags.includes("scalp-detector-context-required"));
});

test("independent scalp veto accepts the 50x ceiling without blanket-rejecting a volatile regime", () => {
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

  assert.equal(result.shouldTrade, true);
  assert.equal(result.explanationTags.includes("scalp-leverage-cap-veto"), false);
  assert.equal(result.explanationTags.includes("scalp-volatility-veto"), false);
});

test("independent scalp veto rejects leverage below 25x or above 50x", () => {
  for (const leverage of [24.99, 50.01]) {
    const payload = continuationPayload({
      requestedTrade: {
        ...continuationPayload().requestedTrade,
        leverage,
      },
    });

    const result = evaluateTradeDecision(payload);
    assert.equal(result.shouldTrade, false);
    assert.ok(result.explanationTags.includes("scalp-leverage-cap-veto"));
    assert.match(result.explanationSummary, /25-50x scalp range/);
  }
});

test("independent scalp veto accepts a fully confirmed setup during a wide 145-minute range", () => {
  const payload = continuationPayload({
    marketContext: {
      ...continuationPayload().marketContext,
      volatilityPercent: 5.3,
    },
  });

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, true);
  assert.equal(result.explanationTags.includes("scalp-volatility-veto"), false);
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
    estimatedRoundTripFeeRate: 0.006,
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
      "ONE_CANDLE_CANDIDATE_CONFIRMED",
      "LIVE_ENTRY_PRICE_VALIDATED",
      "RANGE_EXTREME_OBSERVED",
      "RANGE_BAND_REENTRY",
      "RANGE_MOMENTUM_TURN",
      "RANGE_CONFIRMING_CANDLE",
      "RANGE_INDICATOR_SUPPORT",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ],
  };

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, true);
  assert.ok(result.explanationTags.includes("scalp-path-range-reversal"));
});

test("authoritative breakout/retest metadata is not re-vetoed by a duplicate ATR pass", () => {
  const payload = continuationPayload();
  payload.strategyContext = {
    ...payload.strategyContext!,
    scalpEntryPath: "breakout-retest",
    priceActionScore: 0.75,
    priceActionTags: [
      "PRICE_BREAKOUT",
      "ONE_CANDLE_CANDIDATE_CONFIRMED",
      "LIVE_ENTRY_PRICE_VALIDATED",
      "PRICE_BREAKOUT_RETEST",
      "PRICE_BREAKOUT_RESUMPTION",
      "INDICATORS_CONFIRMED_BREAKOUT_RETEST",
      "BREAKOUT_EVIDENCE_CONSENSUS",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ],
    indicators: {
      ...payload.strategyContext!.indicators!,
      atrPercent: 0.089,
    },
  };

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, true);
  assert.equal(result.explanationTags.includes("scalp-directional-indicator-veto"), false);
});

test("the isolated $12 low-balance order bypasses the 50% decision allocation veto", () => {
  const payload = continuationPayload({
    requestedTrade: {
      ...continuationPayload().requestedTrade,
      collateralUsd: 12,
    },
    marketContext: {
      ...continuationPayload().marketContext,
      availableUsdc: 20,
    },
  });

  const result = evaluateTradeDecision(payload);

  assert.equal(result.shouldTrade, true);
  assert.ok(result.explanationTags.includes("scalp-low-balance-minimum-trade"));
  assert.equal(result.explanationTags.includes("scalp-allocation-veto"), false);
});
