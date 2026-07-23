import type { UserParams } from "@/lib/signal/engine";

export const OPERATOR_TRAINING_BASELINE = {
  version: 2,
  signalParams: {
    trendWindow: 145,
    trendThreshold: 1.65,
    breakoutPercent: 0.35,
    cooldownSeconds: 27_000,
  } satisfies UserParams,
  maximumAllocationPercent: 80,
  targetWalletRiskPercent: 3,
  takeProfitRoePercent: 10,
  stopLossRoePercent: 10,
  minimumConfidence: 0.68,
  leverageFloor: 2,
  leverageCap: 10,
  leverageQualityExponent: 2.5,
  leverageVolatilityPenalty: 1.25,
  leverageLossStepdown: 1,
} as const;
