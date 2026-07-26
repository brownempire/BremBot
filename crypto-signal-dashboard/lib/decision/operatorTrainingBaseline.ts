import crypto from "node:crypto";

import type { DecisionLearningProfile } from "@/lib/decision/learningTypes";
import { OPERATOR_TRAINING_BASELINE } from "@/lib/decision/operatorTrainingBaselineConstants";
import { BASE_INDICATOR_SETTINGS } from "@/lib/signal/indicators";
import { DEFAULT_SCALP_LEARNING_PROFILE } from "@/lib/perps/scalpEngine";

export function makeOperatorTrainingBaselineProfile(
  walletAddress: string,
  version: number
): DecisionLearningProfile {
  const now = new Date().toISOString();
  const baseline = OPERATOR_TRAINING_BASELINE;
  return {
    profileId: `learn_${crypto.randomUUID()}`,
    walletAddress,
    version,
    status: "candidate",
    source: "operator-baseline",
    createdAt: now,
    promotedAt: null,
    learnedFromClosedTrades: 0,
    strategyBaselineVersion: baseline.version,
    minimumConfidence: baseline.minimumConfidence,
    leverageFloor: baseline.leverageFloor,
    leverageCap: baseline.leverageCap,
    leverageQualityExponent: baseline.leverageQualityExponent,
    leverageVolatilityPenalty: baseline.leverageVolatilityPenalty,
    leverageLossStepdown: baseline.leverageLossStepdown,
    consecutiveLosses: 0,
    maximumAllocationPercent: baseline.maximumAllocationPercent,
    targetWalletRiskPercent: baseline.targetWalletRiskPercent,
    preferredDirection: "balanced",
    trendWindow: baseline.signalParams.trendWindow,
    cooldownSeconds: baseline.signalParams.cooldownSeconds,
    takeProfitRoePercent: baseline.takeProfitRoePercent,
    stopLossRoePercent: baseline.stopLossRoePercent,
    minimumRewardRiskRatio: 1,
    atrLookback: 14,
    atrStopMultiplier: 1.5,
    volatilityCeilingPercent: 5,
    indicatorSettings: {
      longRsiMin: BASE_INDICATOR_SETTINGS.longRsiMin,
      longRsiMax: BASE_INDICATOR_SETTINGS.longRsiMax,
      shortRsiMin: BASE_INDICATOR_SETTINGS.shortRsiMin,
      shortRsiMax: BASE_INDICATOR_SETTINGS.shortRsiMax,
      minimumAdx: BASE_INDICATOR_SETTINGS.minimumAdx,
      minimumVolumeRatio: BASE_INDICATOR_SETTINGS.minimumVolumeRatio,
      minimumScore: BASE_INDICATOR_SETTINGS.minimumScore,
    },
    scalpProfile: structuredClone(DEFAULT_SCALP_LEARNING_PROFILE),
    assetAdjustments: {
      SOL: { trendThreshold: baseline.signalParams.trendThreshold, breakoutPercent: baseline.signalParams.breakoutPercent, leverageMultiplier: 1, allocationMultiplier: 1 },
      ETH: { trendThreshold: baseline.signalParams.trendThreshold, breakoutPercent: baseline.signalParams.breakoutPercent, leverageMultiplier: 1, allocationMultiplier: 1 },
      BTC: { trendThreshold: baseline.signalParams.trendThreshold, breakoutPercent: baseline.signalParams.breakoutPercent, leverageMultiplier: 1, allocationMultiplier: 1 },
    },
    validation: {
      sampleSize: 0,
      trainingSize: 0,
      validationSize: 0,
      winRate: 0,
      expectancyUsd: 0,
      profitFactor: 0,
      maxDrawdownUsd: 0,
      passed: true,
      reasons: ["Operator-selected baseline activated while BremLogic collects enough closed trades for walk-forward training."],
    },
    summary: "Research baseline: isolated Smart trend/breakout learning plus adaptive scalp range/reversal learning, a 145-minute Smart window, 1.65% trend, 0.35% breakout, 7.5-hour Smart cooldown, 50% allocation ceiling, 3% target wallet risk, 25% TP, 25% SL, and quality-adjusted 2–10x leverage.",
  };
}
