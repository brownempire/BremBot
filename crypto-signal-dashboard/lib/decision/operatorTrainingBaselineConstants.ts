import type { UserParams } from "@/lib/signal/engine";

export const OPERATOR_TRAINING_BASELINE = {
  signalParams: {
    trendWindow: 15,
    trendThreshold: 0.14,
    breakoutPercent: 0.19,
    cooldownSeconds: 180,
  } satisfies UserParams,
  maximumAllocationPercent: 80,
  takeProfitRoePercent: 25,
  stopLossRoePercent: 25,
  leverageCap: 50,
} as const;

export const AGENT_STOP_LOSS_ROE_PERCENT = OPERATOR_TRAINING_BASELINE.stopLossRoePercent;
