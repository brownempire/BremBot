/**
 * Conservative fee fallback derived from the upper quartile of the recent
 * production scalp outcomes audited on 2026-08-19. Callers should prefer the
 * rolling resolver below when eligible closed outcomes are available.
 */
export const DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE = 0.00205;
export const ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE = DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
export const SCALP_ATR_PROFIT_TARGET_MULTIPLIER = 2;
export const DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT = 25;
export const SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT = 25;
export const SCALP_STOP_LOSS_ROE_PERCENT = 23;
export const SCALP_MINIMUM_NET_REWARD_RISK_RATIO = 1.25;
export const SCALP_MINIMUM_NET_PROFIT_USD = 1;
export const MIN_TPSL_EXPECTED_PNL_USD = 1;

type ScalpFeeOutcome = {
  feesUsd: number;
  sizeUsd: number;
  signalType?: string | null;
  scalpSetupType?: string | null;
  trainingEligible?: boolean;
};

export function resolveConservativeScalpFeeRate(
  outcomes: ScalpFeeOutcome[],
  fallbackRate = DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE
) {
  const safeFallback = Number.isFinite(fallbackRate) && fallbackRate > 0
    ? fallbackRate
    : DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
  const rates = outcomes
    .filter((outcome) => (
      outcome.trainingEligible !== false
      && (outcome.signalType === "scalp" || Boolean(outcome.scalpSetupType))
      && Number.isFinite(outcome.feesUsd)
      && outcome.feesUsd >= 0
      && Number.isFinite(outcome.sizeUsd)
      && outcome.sizeUsd > 0
    ))
    .map((outcome) => outcome.feesUsd / outcome.sizeUsd)
    .filter((rate) => Number.isFinite(rate) && rate > 0 && rate <= 0.01)
    .slice(-20)
    .sort((left, right) => left - right);
  if (rates.length === 0) return safeFallback;
  const upperQuartileIndex = Math.ceil((rates.length - 1) * 0.75);
  return Math.max(safeFallback, rates[upperQuartileIndex] ?? safeFallback);
}

export type PercentageScalpExitPlan = {
  estimatedFeesUsd: number;
  estimatedStopLossNetUsd: number;
  minimumRewardRiskNetProfitUsd: number;
  volatilityTargetRoePercent: number | null;
  targetRoePercent: number;
  grossProfitTargetUsd: number;
  netProfitTargetUsd: number;
};

export function computePercentageScalpExitPlan(options: {
  positionSizeUsd: number;
  leverage: number;
  atrPercent: number | null;
  configuredTakeProfitRoePercent: number;
  estimatedRoundTripFeeRate?: number;
}): PercentageScalpExitPlan {
  const positionSizeUsd = Math.max(0, options.positionSizeUsd);
  const leverage = Math.max(1, options.leverage);
  const collateralUsd = positionSizeUsd / leverage;
  const feeRate = Number.isFinite(options.estimatedRoundTripFeeRate)
    && (options.estimatedRoundTripFeeRate ?? 0) > 0
    ? options.estimatedRoundTripFeeRate!
    : DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
  const estimatedFeesUsd = positionSizeUsd * feeRate;
  const estimatedStopLossNetUsd = collateralUsd * SCALP_STOP_LOSS_ROE_PERCENT / 100 + estimatedFeesUsd;
  const minimumRewardRiskNetProfitUsd = estimatedStopLossNetUsd * SCALP_MINIMUM_NET_REWARD_RISK_RATIO;
  const configuredTargetRoePercent = Math.max(
    SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT,
    options.configuredTakeProfitRoePercent
  );
  const volatilityTargetRoePercent = typeof options.atrPercent === "number"
    && Number.isFinite(options.atrPercent)
    && options.atrPercent > 0
      ? options.atrPercent * SCALP_ATR_PROFIT_TARGET_MULTIPLIER * leverage
      : null;
  const baseTargetRoePercent = volatilityTargetRoePercent === null
    ? configuredTargetRoePercent
    : Math.min(100, Math.max(configuredTargetRoePercent, volatilityTargetRoePercent));
  const percentageGrossProfitUsd = collateralUsd * baseTargetRoePercent / 100;
  const grossProfitTargetUsd = Math.max(
    MIN_TPSL_EXPECTED_PNL_USD,
    estimatedFeesUsd + SCALP_MINIMUM_NET_PROFIT_USD,
    estimatedFeesUsd + minimumRewardRiskNetProfitUsd,
    percentageGrossProfitUsd
  );
  const targetRoePercent = collateralUsd > 0
    ? grossProfitTargetUsd / collateralUsd * 100
    : baseTargetRoePercent;

  return {
    estimatedFeesUsd: Number(estimatedFeesUsd.toFixed(6)),
    estimatedStopLossNetUsd: Number(estimatedStopLossNetUsd.toFixed(6)),
    minimumRewardRiskNetProfitUsd: Number(minimumRewardRiskNetProfitUsd.toFixed(6)),
    volatilityTargetRoePercent: volatilityTargetRoePercent === null
      ? null
      : Number(volatilityTargetRoePercent.toFixed(6)),
    targetRoePercent: Number(targetRoePercent.toFixed(6)),
    grossProfitTargetUsd: Number(grossProfitTargetUsd.toFixed(6)),
    netProfitTargetUsd: Number((grossProfitTargetUsd - estimatedFeesUsd).toFixed(6)),
  };
}
