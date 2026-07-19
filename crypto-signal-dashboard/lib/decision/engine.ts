import crypto from "node:crypto";

import { getTradeDecisionConfig } from "@/lib/decision/config";
import type {
  TradeDecisionPayload,
  TradeDecisionRecommendation,
  TradeDecisionRecord,
} from "@/lib/decision/types";
import type { DecisionLearningProfile } from "@/lib/decision/learningTypes";
import type { PerpsAutomationSession, PerpsAgentSignal, PerpsUserExecution } from "@/lib/perps/sessionTypes";

const DECISION_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1_000;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, fractionDigits = 2) {
  return Number(value.toFixed(fractionDigits));
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
    shadowMode: config.shadowMode,
  };
}

export function evaluateTradeDecision(payload: TradeDecisionPayload, learningProfile: DecisionLearningProfile | null = null): TradeDecisionRecommendation {
  const config = getTradeDecisionConfig();
  const tags = new Set<string>(["decision-layer", payload.shadowMode ? "shadow-mode" : "active-mode"]);
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
}): TradeDecisionRecord {
  const payload = buildTradeDecisionPayload(input);
  const recommendation = evaluateTradeDecision(payload, input.learningProfile ?? null);
  return {
    payload,
    recommendation,
  };
}
