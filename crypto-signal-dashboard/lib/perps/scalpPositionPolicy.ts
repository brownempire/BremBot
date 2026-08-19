import type { JupiterPerpsPosition } from "@/lib/jupiterPerps";
import { SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED } from "@/lib/perps/scalpEngine";

export const SCALP_MAX_CONCURRENT_POSITIONS = 2;
export const SCALP_REVERSAL_MINIMUM_CONFIDENCE = 0.85;
export const SCALP_REVERSAL_MINIMUM_PRICE_ACTION_SCORE = 0.9;
export const SCALP_REVERSAL_MINIMUM_PROJECTED_SURPLUS_USD = 1;
export const ESTIMATED_PERPS_CLOSE_FEE_RATE = 0.0006;

export type ScalpPositionPolicyDecision =
  | { action: "open" }
  | { action: "hold-concurrent"; existingPosition: JupiterPerpsPosition }
  | {
      action: "reverse";
      existingPosition: JupiterPerpsPosition;
      estimatedCloseFeeUsd: number;
      projectedSurplusUsd: number;
    }
  | { action: "block"; code: "SAME_SIDE_POSITION_OPEN" | "MAX_CONCURRENT_POSITIONS"; message: string };

export function evaluateScalpPositionPolicy(options: {
  openPositions: JupiterPerpsPosition[];
  candidateSide: "long" | "short";
  setupType: "range-reversal" | "liquidity-sweep" | "v-reversal" | "double-reversal";
  confidence: number;
  priceActionScore: number;
  indicatorBypass: boolean;
  projectedNetProfitUsd: number;
}): ScalpPositionPolicyDecision {
  if (options.openPositions.length === 0) return { action: "open" };

  const sameSide = options.openPositions.find((position) => position.side === options.candidateSide);
  if (sameSide) {
    return {
      action: "block",
      code: "SAME_SIDE_POSITION_OPEN",
      message: `A ${options.candidateSide} position is already open. Jupiter would merge another same-side entry instead of preserving it as an independently protected scalp trade.`,
    };
  }
  if (options.openPositions.length >= SCALP_MAX_CONCURRENT_POSITIONS) {
    return {
      action: "block",
      code: "MAX_CONCURRENT_POSITIONS",
      message: `The scalp agent already has ${SCALP_MAX_CONCURRENT_POSITIONS} independently managed positions open.`,
    };
  }

  const existingPosition = options.openPositions[0]!;
  const currentNetPnlUsd = typeof existingPosition.unrealizedPnl === "number"
    && Number.isFinite(existingPosition.unrealizedPnl)
    ? existingPosition.unrealizedPnl
    : null;
  const positionValueUsd = typeof existingPosition.positionValue === "number"
    && Number.isFinite(existingPosition.positionValue)
    ? Math.max(0, existingPosition.positionValue)
    : 0;
  const estimatedCloseFeeUsd = positionValueUsd * ESTIMATED_PERPS_CLOSE_FEE_RATE;
  const projectedSurplusUsd = currentNetPnlUsd === null
    ? Number.NEGATIVE_INFINITY
    : options.projectedNetProfitUsd + Math.min(0, currentNetPnlUsd) - estimatedCloseFeeUsd;
  const exceptionalOppositeReversal = SCALP_EXCEPTIONAL_REVERSAL_BYPASS_ENABLED
    && options.setupType === "liquidity-sweep"
    && options.indicatorBypass
    && options.confidence >= SCALP_REVERSAL_MINIMUM_CONFIDENCE
    && options.priceActionScore >= SCALP_REVERSAL_MINIMUM_PRICE_ACTION_SCORE;

  if (
    exceptionalOppositeReversal
    && currentNetPnlUsd !== null
    && currentNetPnlUsd < 0
    && projectedSurplusUsd >= SCALP_REVERSAL_MINIMUM_PROJECTED_SURPLUS_USD
    && existingPosition.accountRef
  ) {
    return {
      action: "reverse",
      existingPosition,
      estimatedCloseFeeUsd: Number(estimatedCloseFeeUsd.toFixed(6)),
      projectedSurplusUsd: Number(projectedSurplusUsd.toFixed(6)),
    };
  }

  return { action: "hold-concurrent", existingPosition };
}
