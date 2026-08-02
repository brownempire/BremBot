export const ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE = 0.0012;
export const SCALP_ATR_PROFIT_TARGET_MULTIPLIER = 2;
export const DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT = 25;
export const SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT = 25;
export const SCALP_STOP_LOSS_ROE_PERCENT = 15;
export const SCALP_MINIMUM_NET_PROFIT_USD = 1;
export const MIN_TPSL_EXPECTED_PNL_USD = 1;

export type PercentageScalpExitPlan = {
  estimatedFeesUsd: number;
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
}): PercentageScalpExitPlan {
  const positionSizeUsd = Math.max(0, options.positionSizeUsd);
  const leverage = Math.max(1, options.leverage);
  const collateralUsd = positionSizeUsd / leverage;
  const estimatedFeesUsd = positionSizeUsd * ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE;
  const configuredTargetRoePercent = Math.max(
    SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT,
    options.configuredTakeProfitRoePercent
  );
  const volatilityTargetRoePercent = typeof options.atrPercent === "number"
    && Number.isFinite(options.atrPercent)
    && options.atrPercent > 0
      ? options.atrPercent * SCALP_ATR_PROFIT_TARGET_MULTIPLIER * leverage
      : null;
  const targetRoePercent = volatilityTargetRoePercent === null
    ? configuredTargetRoePercent
    : Math.min(100, Math.max(configuredTargetRoePercent, volatilityTargetRoePercent));
  const percentageGrossProfitUsd = collateralUsd * targetRoePercent / 100;
  const grossProfitTargetUsd = Math.max(
    MIN_TPSL_EXPECTED_PNL_USD,
    estimatedFeesUsd + SCALP_MINIMUM_NET_PROFIT_USD,
    percentageGrossProfitUsd
  );

  return {
    estimatedFeesUsd: Number(estimatedFeesUsd.toFixed(6)),
    volatilityTargetRoePercent: volatilityTargetRoePercent === null
      ? null
      : Number(volatilityTargetRoePercent.toFixed(6)),
    targetRoePercent: Number(targetRoePercent.toFixed(6)),
    grossProfitTargetUsd: Number(grossProfitTargetUsd.toFixed(6)),
    netProfitTargetUsd: Number((grossProfitTargetUsd - estimatedFeesUsd).toFixed(6)),
  };
}
