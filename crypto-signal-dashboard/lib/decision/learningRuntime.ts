import type { DecisionLearningProfile, LearningAsset } from "@/lib/decision/learningTypes";
import type { PerpsAutomationConfig } from "@/lib/perps/automationConfig";
import type { PricePoint } from "@/lib/price/simulated";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function computeAtrPercent(points: PricePoint[], lookback = 14) {
  const recent = points.slice(-Math.max(2, lookback + 1));
  const trueRanges: number[] = [];
  for (let index = 1; index < recent.length; index += 1) {
    const current = recent[index];
    const previous = recent[index - 1];
    if (!current || !previous || previous.v <= 0) continue;
    const high = current.h ?? Math.max(current.o ?? previous.v, current.v);
    const low = current.l ?? Math.min(current.o ?? previous.v, current.v);
    const trueRange = Math.max(high - low, Math.abs(high - previous.v), Math.abs(low - previous.v));
    trueRanges.push(trueRange / previous.v * 100);
  }
  return trueRanges.length > 0
    ? trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length
    : 0;
}

export function getLearnedSignalParams(config: PerpsAutomationConfig, asset: LearningAsset, profile: DecisionLearningProfile | null) {
  if (!profile) return config.params;
  const adjustment = profile.assetAdjustments[asset];
  return {
    trendWindow: profile.trendWindow,
    trendThreshold: adjustment.trendThreshold,
    breakoutPercent: adjustment.breakoutPercent,
    cooldownSeconds: profile.cooldownSeconds,
  };
}

export function applyLearnedTradePlan(input: {
  basePlan: {
    collateralPercent: number;
    leverage: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    volatilityPercent: number;
  };
  asset: LearningAsset;
  points: PricePoint[];
  profile: DecisionLearningProfile | null;
}) {
  if (!input.profile) {
    return { ...input.basePlan, atrPercent: computeAtrPercent(input.points), profileId: null };
  }
  const adjustment = input.profile.assetAdjustments[input.asset];
  const leverage = clamp(
    input.basePlan.leverage * adjustment.leverageMultiplier,
    1,
    input.profile.leverageCap
  );
  const atrPercent = computeAtrPercent(input.points, input.profile.atrLookback);
  const atrStopRoe = atrPercent * input.profile.atrStopMultiplier * leverage;
  const stopLossPercent = clamp(
    Math.max(input.profile.stopLossRoePercent, atrStopRoe),
    0.5,
    5.5
  );
  const estimatedRoundTripFeeRoe = 0.12 * leverage;
  const feeAdjustedRewardTarget = input.profile.minimumRewardRiskRatio
    * (stopLossPercent + estimatedRoundTripFeeRoe)
    + estimatedRoundTripFeeRoe;
  const takeProfitPercent = clamp(
    Math.max(input.profile.takeProfitRoePercent, feeAdjustedRewardTarget),
    1,
    50
  );
  if (input.profile.source === "operator-baseline" && input.profile.learnedFromClosedTrades === 0) {
    return {
      collateralPercent: Number(clamp(
        Math.min(input.basePlan.collateralPercent, input.profile.maximumAllocationPercent) * adjustment.allocationMultiplier,
        1,
        input.profile.maximumAllocationPercent
      ).toFixed(2)),
      leverage: Number(leverage.toFixed(2)),
      stopLossPercent: Number(stopLossPercent.toFixed(2)),
      takeProfitPercent: Number(takeProfitPercent.toFixed(2)),
      volatilityPercent: input.basePlan.volatilityPercent,
      atrPercent: Number(atrPercent.toFixed(4)),
      profileId: input.profile.profileId,
    };
  }
  const riskSizedAllocation = input.profile.targetWalletRiskPercent / stopLossPercent * 100;
  const collateralPercent = clamp(
    Math.min(
      input.basePlan.collateralPercent,
      input.profile.maximumAllocationPercent,
      riskSizedAllocation
    ) * adjustment.allocationMultiplier,
    1,
    input.profile.maximumAllocationPercent
  );
  return {
    collateralPercent: Number(collateralPercent.toFixed(2)),
    leverage: Number(leverage.toFixed(2)),
    stopLossPercent: Number(stopLossPercent.toFixed(2)),
    takeProfitPercent: Number(takeProfitPercent.toFixed(2)),
    volatilityPercent: input.basePlan.volatilityPercent,
    atrPercent: Number(atrPercent.toFixed(4)),
    profileId: input.profile.profileId,
  };
}
