import crypto from "node:crypto";

import { getTradeDecisionConfig } from "@/lib/decision/config";
import type {
  TradeDecisionPayload,
  TradeDecisionRecommendation,
  TradeDecisionRecord,
} from "@/lib/decision/types";
import type { DecisionLearningProfile } from "@/lib/decision/learningTypes";
import {
  SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED,
  SCALP_EXHAUSTION_BLOCK_ENABLED,
  SCALP_MAX_145M_NET_OR_RANGE_PERCENT,
  SCALP_POLICY_VERSION,
} from "@/lib/perps/scalpEngine";
import {
  SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE,
  SCALP_MINIMUM_LEVERAGE,
} from "@/lib/perps/scalpLeverage";
import { isIsolatedLowBalanceMinimumTrade } from "@/lib/perps/scalpAllocation";
import {
  ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE,
  SCALP_MINIMUM_NET_REWARD_RISK_RATIO,
} from "@/lib/perps/scalpExit";
import type { PerpsAutomationSession, PerpsAgentSignal, PerpsUserExecution } from "@/lib/perps/sessionTypes";

const DECISION_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SCALP_REWARD_RISK_ROUNDING_TOLERANCE = 0.02;

type ScalpDecisionPath = "continuation" | "breakout-retest" | "range-reversal" | "reversal" | "unknown";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, fractionDigits = 2) {
  return Number(value.toFixed(fractionDigits));
}

function includesAll(tags: Set<string>, required: string[]) {
  return required.every((tag) => tags.has(tag));
}

function resolveScalpDecisionPath(tags: Set<string>): ScalpDecisionPath {
  if (tags.has("INDICATORS_CONFIRMED_TREND_CONTINUATION")) return "continuation";
  if (tags.has("INDICATORS_CONFIRMED_BREAKOUT_RETEST")) return "breakout-retest";
  if (tags.has("SCALP_RANGE")) return "range-reversal";
  if (
    tags.has("INDICATORS_CONFIRMED_STRONG_PRICE_ACTION")
    || tags.has("INDICATORS_CONFIRMED_PRICE_ACTION")
  ) return "reversal";
  return "unknown";
}

function scalpPathHasCompleteConfirmation(path: ScalpDecisionPath, tags: Set<string>) {
  if (path === "continuation") {
    return includesAll(tags, [
      "SIGNAL_CANDLE_CONFIRMED",
      "ONE_CANDLE_CANDIDATE_CONFIRMED",
      "LIVE_ENTRY_PRICE_VALIDATED",
      "CONTINUATION_PULLBACK_RETEST_RESUMPTION",
      "CONTINUATION_CONFIRMATION_CONSENSUS",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ]);
  }
  if (path === "breakout-retest") {
    return includesAll(tags, [
      "ONE_CANDLE_CANDIDATE_CONFIRMED",
      "LIVE_ENTRY_PRICE_VALIDATED",
      "PRICE_BREAKOUT",
      "PRICE_BREAKOUT_RETEST",
      "PRICE_BREAKOUT_RESUMPTION",
      "BREAKOUT_EVIDENCE_CONSENSUS",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ]);
  }
  if (path === "range-reversal") {
    return includesAll(tags, [
      "ONE_CANDLE_CANDIDATE_CONFIRMED",
      "LIVE_ENTRY_PRICE_VALIDATED",
      "RANGE_EXTREME_OBSERVED",
      "RANGE_BAND_REENTRY",
      "RANGE_ENTRY_DISTANCE_VALIDATED",
      "RANGE_MOMENTUM_TURN",
      "RANGE_CONFIRMING_CANDLE",
      "RANGE_INDICATOR_SUPPORT",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ]);
  }
  if (path === "reversal") {
    return includesAll(tags, [
      "SIGNAL_CANDLE_CONFIRMED",
      "ONE_CANDLE_CANDIDATE_CONFIRMED",
      "LIVE_ENTRY_PRICE_VALIDATED",
      "SCALP_EXHAUSTION_GUARD_PASSED",
    ]);
  }
  return false;
}

function computeScalpNetRewardRisk(payload: TradeDecisionPayload) {
  const entry = payload.marketContext.spotPrice;
  const takeProfit = payload.requestedTrade.takeProfitPrice;
  const stopLoss = payload.requestedTrade.stopLossPrice;
  if (!entry || !takeProfit || !stopLoss) return null;
  const isLong = payload.direction === "bullish";
  const correctlyOrdered = isLong
    ? takeProfit > entry && stopLoss < entry
    : takeProfit < entry && stopLoss > entry;
  if (!correctlyOrdered) return null;
  const grossRewardRate = Math.abs(takeProfit - entry) / entry;
  const grossLossRate = Math.abs(stopLoss - entry) / entry;
  const observedFeeRate = payload.strategyContext?.estimatedRoundTripFeeRate;
  const feeRate = typeof observedFeeRate === "number" && Number.isFinite(observedFeeRate)
    ? Math.max(ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE, observedFeeRate)
    : ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE;
  const netRewardRate = grossRewardRate - feeRate;
  const netLossRate = grossLossRate + feeRate;
  if (netRewardRate <= 0 || netLossRate <= 0) return null;
  return netRewardRate / netLossRate;
}

function adjustTriggerPrice(
  direction: "bullish" | "bearish",
  kind: "tp" | "sl",
  spotPrice: number | null,
  triggerPrice: number | null,
  multiplier: number
) {
  if (
    typeof spotPrice !== "number"
    || !Number.isFinite(spotPrice)
    || spotPrice <= 0
    || typeof triggerPrice !== "number"
    || !Number.isFinite(triggerPrice)
    || triggerPrice <= 0
  ) {
    return triggerPrice ?? null;
  }

  const distance = Math.abs(triggerPrice - spotPrice);
  if (!Number.isFinite(distance) || distance <= 0) {
    return triggerPrice;
  }

  const widenedDistance = distance * multiplier;
  if (kind === "tp") {
    return round(
      direction === "bullish"
        ? spotPrice + widenedDistance
        : spotPrice - widenedDistance,
      2
    );
  }

  return round(
    direction === "bullish"
      ? spotPrice - widenedDistance
      : spotPrice + widenedDistance,
    2
  );
}

export function buildTradeDecisionPayload(input: {
  walletAddress: string;
  session: PerpsAutomationSession;
  signal: PerpsAgentSignal;
  existingExecutions: PerpsUserExecution[];
  shadowMode?: boolean;
}): TradeDecisionPayload {
  const { walletAddress, session, signal, existingExecutions } = input;
  const config = getTradeDecisionConfig();
  const historyCutoff = Date.now() - DECISION_HISTORY_WINDOW_MS;
  const recentExecutions = existingExecutions
    .filter((execution) => {
      const timestamp = Date.parse(execution.updatedAt ?? execution.createdAt);
      return Number.isFinite(timestamp) && timestamp >= historyCutoff;
    })
    .slice(0, 20);
  const countByStatus = (status: PerpsUserExecution["status"]) => recentExecutions.filter((item) => item.status === status).length;
  const failedCount = countByStatus("failed");
  const blockedCount = countByStatus("blocked");

  return {
    decisionId: `pdec_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    walletAddress,
    sessionId: session.sessionId,
    sessionMode: session.mode,
    executionModel: session.executionModel,
    signalId: signal.signalId,
    symbol: signal.symbol,
    summary: signal.summary,
    direction: signal.direction,
    signalConfidence: signal.signalConfidence ?? null,
    asset: signal.asset,
    strategyClass: signal.strategyClass ?? "smart",
    requestedTrade: {
      collateralUsd: signal.collateralUsd,
      leverage: signal.leverage,
      takeProfitPrice: signal.takeProfitPrice ?? null,
      stopLossPrice: signal.stopLossPrice ?? null,
      maxSlippageBps: signal.maxSlippageBps,
      executionStyle: signal.executionStyle ?? null,
      smartTradeProfile: signal.smartTradeProfile ?? null,
    },
    marketContext: {
      spotPrice: signal.marketContext?.spotPrice ?? null,
      volatilityPercent: signal.marketContext?.volatilityPercent ?? null,
      trendBias: signal.marketContext?.trendBias ?? null,
      availableUsdc: signal.marketContext?.availableUsdc ?? null,
      hasOpenPosition: signal.marketContext?.hasOpenPosition ?? false,
      allowConcurrentPosition: signal.marketContext?.allowConcurrentPosition ?? false,
      recentPriceChangePercent: signal.marketContext?.recentPriceChangePercent ?? null,
    },
    strategyContext: signal.strategyContext
      ? {
          ...signal.strategyContext,
          learningProfileId: signal.strategyContext.learningProfileId ?? null,
        }
      : null,
    historyContext: {
      recentExecutionCount: recentExecutions.length,
      approvalRequiredCount: countByStatus("approval_required"),
      submittedCount: countByStatus("submitted"),
      confirmedCount: countByStatus("confirmed") + countByStatus("closed"),
      paperExecutedCount: countByStatus("paper_executed"),
      blockedCount,
      failedCount,
      recentFailureRate: recentExecutions.length > 0 ? failedCount / recentExecutions.length : 0,
      recentBlockedRate: recentExecutions.length > 0 ? blockedCount / recentExecutions.length : 0,
    },
    shadowMode: input.shadowMode ?? config.shadowMode,
  };
}

export function evaluateTradeDecision(payload: TradeDecisionPayload, learningProfile: DecisionLearningProfile | null = null): TradeDecisionRecommendation {
  const config = getTradeDecisionConfig();
  if (payload.strategyClass === "scalp") {
    const context = payload.strategyContext;
    const rawTags = new Set(context?.priceActionTags ?? []);
    const entryPath = context?.scalpEntryPath ?? resolveScalpDecisionPath(rawTags);
    const detectorQualified = Boolean(
      context
      && context.signalType === "scalp"
      && context.scalpPolicyVersion === SCALP_POLICY_VERSION
      && context.scalpSetupType
      && typeof context.priceActionScore === "number"
      && context.priceActionScore > 0
      && context.priceActionTags
      && context.priceActionTags.length > 0
    );
    const rawConfidence = typeof payload.signalConfidence === "number"
      ? payload.signalConfidence
      : context?.priceActionScore ?? 0;
    // The detector arbiter has already combined path structure and supporting
    // evidence. Preserve that quality estimate instead of re-scoring it from
    // one duplicated price-action component.
    const confidence = clamp(rawConfidence, 0, 1);
    const concurrentPositionAllowed = payload.marketContext.hasOpenPosition
      && payload.marketContext.allowConcurrentPosition === true;
    const pausedExceptionalBypass = context?.indicatorBypass === true
      && !SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED;
    const completeSetupConfirmation = scalpPathHasCompleteConfirmation(entryPath, rawTags);
    // Scalp leverage is an execution policy, independent from legacy Smart
    // learning-profile ranges that may still be persisted as 2-20x.
    const leverageQualified = payload.requestedTrade.leverage >= SCALP_MINIMUM_LEVERAGE
      && payload.requestedTrade.leverage <= SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE;
    const volatilityCeiling = Math.min(
      SCALP_MAX_145M_NET_OR_RANGE_PERCENT,
      learningProfile?.volatilityCeilingPercent ?? SCALP_MAX_145M_NET_OR_RANGE_PERCENT
    );
    const volatility = payload.marketContext.volatilityPercent;
    const volatilityQualified = !SCALP_EXHAUSTION_BLOCK_ENABLED || (
      typeof volatility === "number"
      && Number.isFinite(volatility)
      && volatility <= volatilityCeiling
    );
    const netRewardRisk = computeScalpNetRewardRisk(payload);
    const economicsQualified = netRewardRisk !== null
      && netRewardRisk >= SCALP_MINIMUM_NET_REWARD_RISK_RATIO - SCALP_REWARD_RISK_ROUNDING_TOLERANCE;
    const availableUsdc = payload.marketContext.availableUsdc;
    const allocationPercent = typeof availableUsdc === "number" && availableUsdc > 0
      ? payload.requestedTrade.collateralUsd / availableUsdc * 100
      : null;
    const lowBalanceMinimumTrade = isIsolatedLowBalanceMinimumTrade({
      availableUsdc,
      collateralUsd: payload.requestedTrade.collateralUsd,
      hasOpenPosition: payload.marketContext.hasOpenPosition,
    });
    const allocationQualified = lowBalanceMinimumTrade
      || allocationPercent === null
      || allocationPercent <= (learningProfile?.maximumAllocationPercent ?? 50);
    const shouldTrade = detectorQualified
      && !pausedExceptionalBypass
      && completeSetupConfirmation
      && leverageQualified
      && volatilityQualified
      && economicsQualified
      && allocationQualified
      && (!payload.marketContext.hasOpenPosition || concurrentPositionAllowed);
    const tags = new Set<string>([
      "scalp-detector-authoritative",
      "scalp-independent-veto",
      payload.shadowMode ? "shadow-mode" : "active-mode",
    ]);
    if (context?.scalpSetupType) tags.add(`scalp-${context.scalpSetupType}`);
    tags.add(`scalp-path-${entryPath}`);
    context?.priceActionTags?.forEach((tag) => tags.add(tag));
    if (context?.indicatorBypass) {
      tags.add(pausedExceptionalBypass
        ? "scalp-reversal-indicator-bypass-paused"
        : "scalp-reversal-indicator-bypass");
    }
    if (payload.requestedTrade.takeProfitPrice && payload.requestedTrade.stopLossPrice) {
      tags.add("structured-exits");
    }
    if (!detectorQualified) tags.add("scalp-detector-context-required");
    if (!completeSetupConfirmation) tags.add("scalp-setup-confirmation-required");
    if (!leverageQualified) tags.add("scalp-leverage-cap-veto");
    if (!volatilityQualified) tags.add("scalp-volatility-veto");
    if (!economicsQualified) tags.add("scalp-post-fee-economics-veto");
    if (!allocationQualified) tags.add("scalp-allocation-veto");
    if (lowBalanceMinimumTrade) tags.add("scalp-low-balance-minimum-trade");
    if (payload.marketContext.hasOpenPosition) tags.add("existing-position-open");
    if (concurrentPositionAllowed) tags.add("opposite-side-scalp-position-allowed");
    if (shouldTrade) tags.add("scalp-detector-qualified");

    const explanationSummary = shouldTrade
      ? concurrentPositionAllowed
        ? `The ${entryPath} scalp setup passed authoritative detector, volatility, leverage, and post-fee expectancy checks while the existing position remains independently managed.`
        : `The ${entryPath} scalp setup passed authoritative detector, volatility, leverage, and post-fee expectancy checks.`
      : !detectorQualified
        ? "Scalp execution requires complete metadata produced by the independent scalp detector."
        : pausedExceptionalBypass
          ? "The exceptional scalp indicator bypass remains paused."
          : !completeSetupConfirmation
            ? `The ${entryPath} scalp candidate did not complete its required candle-structure and live confirmation sequence.`
            : !leverageQualified
                  ? `The requested ${payload.requestedTrade.leverage.toFixed(1)}x leverage is outside the independent ${SCALP_MINIMUM_LEVERAGE.toFixed(0)}-${SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE.toFixed(0)}x scalp range.`
                  : !volatilityQualified
                    ? `The current ${typeof volatility === "number" ? volatility.toFixed(2) : "unknown"}% range exceeds the independent ${volatilityCeiling.toFixed(2)}% scalp regime ceiling.`
                    : !economicsQualified
                      ? `The protected exits do not provide the required ${SCALP_MINIMUM_NET_REWARD_RISK_RATIO.toFixed(2)}:1 reward-to-risk after estimated fees.`
                      : !allocationQualified
                        ? "The requested collateral exceeds the learned wallet allocation limit."
                        : "An existing position prevents this scalp entry from opening concurrently.";

    const lowRisk = payload.requestedTrade.leverage <= 30
      && (volatility ?? Number.POSITIVE_INFINITY) <= 1
      && (netRewardRisk ?? 0) >= SCALP_MINIMUM_NET_REWARD_RISK_RATIO;

    return {
      shouldTrade,
      confidenceScore: round(confidence, 4),
      riskGrade: shouldTrade ? (lowRisk ? "low" : "medium") : "high",
      sizeMultiplier: 1,
      leverageMultiplier: 1,
      recommendedCollateralUsd: round(payload.requestedTrade.collateralUsd, 2),
      recommendedLeverage: payload.requestedTrade.leverage,
      recommendedTakeProfitPrice: payload.requestedTrade.takeProfitPrice,
      recommendedStopLossPrice: payload.requestedTrade.stopLossPrice,
      explanationTags: [...tags],
      explanationSummary,
      shadowMode: payload.shadowMode,
    };
  }

  const tags = new Set<string>(["decision-layer", payload.shadowMode ? "shadow-mode" : "active-mode"]);
  tags.add("smart-trade");
  let confidence = 0.55;

  if (typeof payload.signalConfidence === "number") {
    confidence += (payload.signalConfidence - 0.5) * 0.22;
    tags.add("signal-confidence-considered");
  }

  if (learningProfile) {
    tags.add("wallet-trained-profile");
    tags.add(`learning-profile-v${learningProfile.version}`);
    if (learningProfile.preferredDirection !== "balanced") {
      const preferred = learningProfile.preferredDirection === "bullish" ? "bullish" : "bearish";
      if (payload.direction === preferred) {
        confidence += 0.05;
        tags.add("learned-direction-aligned");
      } else {
        confidence -= 0.08;
        tags.add("learned-direction-counter");
      }
    }
    const volatility = payload.marketContext.volatilityPercent;
    if (typeof volatility === "number" && volatility > learningProfile.volatilityCeilingPercent) {
      confidence -= 0.18;
      tags.add("learned-volatility-ceiling-exceeded");
    }
  }

  const trendBias = payload.marketContext.trendBias;
  if (trendBias === payload.direction) {
    confidence += 0.12;
    tags.add("trend-aligned");
  } else if (trendBias && trendBias !== "sideways") {
    confidence -= 0.12;
    tags.add("trend-counter");
  } else if (trendBias === "sideways") {
    confidence -= 0.03;
    tags.add("sideways-market");
  }

  const volatilityPercent = payload.marketContext.volatilityPercent ?? null;
  if (typeof volatilityPercent === "number") {
    if (volatilityPercent >= 7) {
      confidence -= 0.14;
      tags.add("very-high-volatility");
    } else if (volatilityPercent >= 4) {
      confidence -= 0.08;
      tags.add("high-volatility");
    } else if (volatilityPercent <= 1.25) {
      confidence += 0.04;
      tags.add("calm-volatility");
    }
  }

  if (payload.requestedTrade.executionStyle === "smart-trades") {
    confidence += 0.05;
    tags.add("smart-trades-profile");
  }

  if (payload.requestedTrade.leverage >= 8) {
    confidence -= 0.12;
    tags.add("very-high-leverage");
  } else if (payload.requestedTrade.leverage >= 5) {
    confidence -= 0.07;
    tags.add("elevated-leverage");
  }

  if (payload.requestedTrade.takeProfitPrice && payload.requestedTrade.stopLossPrice) {
    confidence += 0.04;
    tags.add("structured-exits");
  } else {
    confidence -= 0.03;
    tags.add("missing-exit-structure");
  }

  if (payload.marketContext.hasOpenPosition) {
    confidence -= 0.22;
    tags.add("existing-position-open");
  }

  const availableUsdc = payload.marketContext.availableUsdc;
  if (typeof availableUsdc === "number" && availableUsdc > 0) {
    const collateralRatio = payload.requestedTrade.collateralUsd / availableUsdc;
    if (collateralRatio >= 0.4) {
      confidence -= 0.1;
      tags.add("heavy-wallet-allocation");
    } else if (collateralRatio <= 0.12) {
      confidence += 0.03;
      tags.add("light-wallet-allocation");
    }
  }

  if (payload.historyContext.failedCount > 0) {
    tags.add("recent-operational-failures-recorded");
  }

  if (payload.historyContext.recentBlockedRate >= 0.4) {
    confidence -= 0.06;
    tags.add("recent-blocked-drag");
  }

  if (payload.historyContext.confirmedCount + payload.historyContext.submittedCount + payload.historyContext.paperExecutedCount > payload.historyContext.failedCount) {
    confidence += 0.04;
    tags.add("recent-execution-support");
  }

  confidence = clamp(confidence, 0.05, 0.95);

  const riskGrade =
    confidence >= 0.72
      ? "low"
      : confidence >= 0.5
        ? "medium"
        : "high";

  let sizeMultiplier =
    confidence >= 0.8
      ? 1.1
      : confidence >= 0.68
        ? 1
        : confidence >= config.confidenceThreshold
          ? 0.8
          : 0.55;

  let leverageMultiplier =
    confidence >= 0.76
      ? 1
      : confidence >= config.confidenceThreshold
        ? 0.9
        : 0.72;

  if (typeof volatilityPercent === "number" && volatilityPercent >= 6) {
    sizeMultiplier -= 0.1;
    leverageMultiplier -= 0.08;
  }

  sizeMultiplier = clamp(sizeMultiplier, 0.35, 1.15);
  leverageMultiplier = clamp(leverageMultiplier, 0.5, 1);

  const triggerDistanceMultiplier =
    typeof volatilityPercent === "number"
      ? volatilityPercent >= 5
        ? 1.12
        : volatilityPercent <= 1.5
          ? 0.94
          : 1
      : 1;

  const recommendedCollateralUsd = round(payload.requestedTrade.collateralUsd * sizeMultiplier, 2);
  const recommendedLeverage = round(Math.min(
    payload.requestedTrade.leverage * leverageMultiplier,
    learningProfile?.leverageCap ?? Number.POSITIVE_INFINITY
  ), 2);
  const recommendedTakeProfitPrice = adjustTriggerPrice(
    payload.direction,
    "tp",
    payload.marketContext.spotPrice,
    payload.requestedTrade.takeProfitPrice,
    triggerDistanceMultiplier
  );
  const recommendedStopLossPrice = adjustTriggerPrice(
    payload.direction,
    "sl",
    payload.marketContext.spotPrice,
    payload.requestedTrade.stopLossPrice,
    triggerDistanceMultiplier
  );

  const confidenceThreshold = learningProfile?.minimumConfidence ?? config.confidenceThreshold;
  const exceedsLearnedVolatility = Boolean(
    learningProfile
    && typeof payload.marketContext.volatilityPercent === "number"
    && payload.marketContext.volatilityPercent > learningProfile.volatilityCeilingPercent
  );
  const shouldTrade = confidence >= confidenceThreshold && !payload.marketContext.hasOpenPosition && !exceedsLearnedVolatility;
  if (shouldTrade) {
    tags.add("passes-confidence-threshold");
  } else {
    tags.add("below-confidence-threshold");
  }

  const explanationSummary = shouldTrade
    ? `Trade qualifies in ${payload.shadowMode ? "shadow" : "active"} mode with ${riskGrade} risk. Suggested sizing and leverage stay within the current rule-based rails.`
    : `Trade is scored as too weak for autonomous acceptance right now. Shadow logging remains active so we can compare this decision against real outcomes over time.`;

  return {
    shouldTrade,
    confidenceScore: round(confidence, 4),
    riskGrade,
    sizeMultiplier: round(sizeMultiplier, 4),
    leverageMultiplier: round(leverageMultiplier, 4),
    recommendedCollateralUsd,
    recommendedLeverage,
    recommendedTakeProfitPrice,
    recommendedStopLossPrice,
    explanationTags: [...tags],
    explanationSummary,
    shadowMode: payload.shadowMode,
  };
}

export function createTradeDecisionRecord(input: {
  walletAddress: string;
  session: PerpsAutomationSession;
  signal: PerpsAgentSignal;
  existingExecutions: PerpsUserExecution[];
  learningProfile?: DecisionLearningProfile | null;
  shadowMode?: boolean;
}): TradeDecisionRecord {
  const payload = buildTradeDecisionPayload(input);
  const recommendation = evaluateTradeDecision(payload, input.learningProfile ?? null);
  return {
    payload,
    recommendation,
  };
}
