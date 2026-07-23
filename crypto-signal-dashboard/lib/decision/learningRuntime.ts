import type { DecisionLearningProfile, LearningAsset } from "@/lib/decision/learningTypes";
import type { PerpsAutomationConfig } from "@/lib/perps/automationConfig";
import type { PricePoint } from "@/lib/price/simulated";
import { AGENT_STOP_LOSS_ROE_PERCENT } from "@/lib/decision/operatorTrainingBaselineConstants";

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
  signalConfidence?: number;
  indicatorScore?: number;
  adx?: number | null;
  volumeRatio?: number | null;
}) {
  if (!input.profile) {
    return {
      ...input.basePlan,
      stopLossPercent: AGENT_STOP_LOSS_ROE_PERCENT,
      atrPercent: computeAtrPercent(input.points),
      profileId: null,
    };
  }
  const adjustment = input.profile.assetAdjustments[input.asset];
  const atrPercent = computeAtrPercent(input.points, input.profile.atrLookback);
  const leverageFloor = Math.min(input.profile.leverageFloor ?? 1, input.profile.leverageCap);
  const confidenceQuality = clamp(((input.signalConfidence ?? input.profile.minimumConfidence) - 0.55) / 0.3, 0, 1);
  const indicatorQuality = clamp(((input.indicatorScore ?? 3) - 3) / 3, 0, 1);
  const adxQuality = clamp(((input.adx ?? 20) - 20) / 20, 0, 1);
  const volumeQuality = clamp(((input.volumeRatio ?? 1) - 1) / 0.5, 0, 1);
  const atrPenalty = clamp((atrPercent - 0.35) / 0.65, 0, 1);
  const rawQuality = clamp(
    confidenceQuality * 0.35
      + indicatorQuality * 0.3
      + adxQuality * 0.2
      + volumeQuality * 0.15
      - atrPenalty * (input.profile.leverageVolatilityPenalty ?? 0),
    0,
    1
  );
  const quality = rawQuality ** (input.profile.leverageQualityExponent ?? 1);
  const qualityLeverage = leverageFloor + (input.profile.leverageCap - leverageFloor) * quality;
  const lossMultiplier = (input.profile.leverageLossStepdown ?? 1) ** Math.min(3, input.profile.consecutiveLosses ?? 0);
  const leverage = clamp(
    qualityLeverage * lossMultiplier * adjustment.leverageMultiplier,
    leverageFloor,
    input.profile.leverageCap
  );
  const riskReferencePercent = clamp(
    AGENT_STOP_LOSS_ROE_PERCENT,
    0.5,
    50
  );
  const takeProfitPercent = clamp(
    input.profile.takeProfitRoePercent,
    1,
    50
  );
  const riskSizedAllocation = input.profile.targetWalletRiskPercent / riskReferencePercent * 100;
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
    stopLossPercent: AGENT_STOP_LOSS_ROE_PERCENT,
    takeProfitPercent: Number(takeProfitPercent.toFixed(2)),
    volatilityPercent: input.basePlan.volatilityPercent,
    atrPercent: Number(atrPercent.toFixed(4)),
    profileId: input.profile.profileId,
  };
}
