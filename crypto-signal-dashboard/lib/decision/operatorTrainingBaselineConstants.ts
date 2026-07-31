import type { UserParams } from "@/lib/signal/engine";

export const OPERATOR_TRAINING_BASELINE = {
  version: 5,
  signalParams: {
    trendWindow: 145,
    trendThreshold: 1.65,
    breakoutPercent: 0.35,
    cooldownSeconds: 27_000,
  } satisfies UserParams,
  maximumAllocationPercent: 50,
  targetWalletRiskPercent: 3,
  takeProfitRoePercent: 25,
  stopLossRoePercent: 25,
  minimumConfidence: 0.68,
  leverageFloor: 2,
  leverageCap: 20,
  leverageQualityExponent: 2.5,
  leverageVolatilityPenalty: 1.25,
  leverageLossStepdown: 1,
} as const;

export const AGENT_STOP_LOSS_ROE_PERCENT = OPERATOR_TRAINING_BASELINE.stopLossRoePercent;
