export const ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE = 0.0012;
export const SCALP_ATR_PROFIT_TARGET_MULTIPLIER = 2;
export const SCALP_MINIMUM_NET_PROFIT_USD = 0.25;
export const MIN_TPSL_EXPECTED_PNL_USD = 1;

export type FeeAwareScalpExitPlan = {
  estimatedFeesUsd: number;
  volatilityGrossProfitUsd: number | null;
  grossProfitTargetUsd: number;
  netProfitTargetUsd: number;
};

export function computeFeeAwareScalpExitPlan(options: {
  positionSizeUsd: number;
  atrPercent: number | null;
  configuredNetProfitUsd: number;
}): FeeAwareScalpExitPlan {
  const positionSizeUsd = Math.max(0, options.positionSizeUsd);
  const estimatedFeesUsd = positionSizeUsd * ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE;
  const configuredGrossProfitUsd = Math.max(0, options.configuredNetProfitUsd) + estimatedFeesUsd;
  const volatilityGrossProfitUsd = typeof options.atrPercent === "number"
    && Number.isFinite(options.atrPercent)
    && options.atrPercent > 0
      ? positionSizeUsd * options.atrPercent / 100 * SCALP_ATR_PROFIT_TARGET_MULTIPLIER
      : null;
  const volatilityScaledGrossProfitUsd = volatilityGrossProfitUsd === null
    ? configuredGrossProfitUsd
    : Math.min(configuredGrossProfitUsd, volatilityGrossProfitUsd);
  const grossProfitTargetUsd = Math.max(
    MIN_TPSL_EXPECTED_PNL_USD,
    estimatedFeesUsd + SCALP_MINIMUM_NET_PROFIT_USD,
    volatilityScaledGrossProfitUsd
  );

  return {
    estimatedFeesUsd: Number(estimatedFeesUsd.toFixed(6)),
    volatilityGrossProfitUsd: volatilityGrossProfitUsd === null
      ? null
      : Number(volatilityGrossProfitUsd.toFixed(6)),
    grossProfitTargetUsd: Number(grossProfitTargetUsd.toFixed(6)),
    netProfitTargetUsd: Number(Math.max(
      SCALP_MINIMUM_NET_PROFIT_USD,
      grossProfitTargetUsd - estimatedFeesUsd
    ).toFixed(6)),
  };
}
