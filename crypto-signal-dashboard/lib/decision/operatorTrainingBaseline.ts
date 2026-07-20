import crypto from "node:crypto";

import type { DecisionLearningProfile } from "@/lib/decision/learningTypes";
import { OPERATOR_TRAINING_BASELINE } from "@/lib/decision/operatorTrainingBaselineConstants";
import { BASE_INDICATOR_SETTINGS } from "@/lib/signal/indicators";

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
    minimumConfidence: 0.62,
    leverageCap: baseline.leverageCap,
    maximumAllocationPercent: baseline.maximumAllocationPercent,
    targetWalletRiskPercent: 1.6,
    preferredDirection: "balanced",
    trendWindow: baseline.signalParams.trendWindow,
    cooldownSeconds: baseline.signalParams.cooldownSeconds,
    takeProfitRoePercent: baseline.takeProfitRoePercent,
    stopLossRoePercent: baseline.stopLossRoePercent,
    minimumRewardRiskRatio: 2,
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
    summary: "Operator baseline: 15-minute window, 0.14% trend, 0.19% breakout, 180-second cooldown, 80% allocation cap, no fixed TP/SL, and 50x leverage cap.",
  };
}
