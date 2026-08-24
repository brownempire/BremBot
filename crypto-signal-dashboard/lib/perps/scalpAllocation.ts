export const MIN_PERPS_COLLATERAL_USD = 10;
export const LOW_BALANCE_TRADE_USD = 12;
export const LOW_BALANCE_TRADE_MAX_USDC = 50;

export function isIsolatedLowBalanceMinimumTrade(options: {
  availableUsdc: number | null | undefined;
  collateralUsd: number;
  hasOpenPosition?: boolean;
  committedCollateralUsd?: number;
}) {
  const availableUsdc = options.availableUsdc;
  return typeof availableUsdc === "number"
    && Number.isFinite(availableUsdc)
    && availableUsdc >= LOW_BALANCE_TRADE_USD
    && availableUsdc < LOW_BALANCE_TRADE_MAX_USDC
    && Math.abs(options.collateralUsd - LOW_BALANCE_TRADE_USD) < 0.000001
    && options.hasOpenPosition !== true
    && (options.committedCollateralUsd ?? 0) === 0;
}
