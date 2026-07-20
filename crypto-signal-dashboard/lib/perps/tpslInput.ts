export type PerpsTpslKind = "tp" | "sl";

export type PerpsTpslPositionBasis = {
  side: "long" | "short";
  entryPrice: number | null;
  leverage: number | null;
  positionValue?: number | null;
  collateralValue?: number | null;
};

function positiveFinite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function resolvePerpsPositionLeverage(position: PerpsTpslPositionBasis) {
  const reportedLeverage = positiveFinite(position.leverage);
  if (reportedLeverage !== null) return reportedLeverage;

  const positionValue = positiveFinite(position.positionValue);
  const collateralValue = positiveFinite(position.collateralValue);
  if (positionValue === null || collateralValue === null) return null;

  const derivedLeverage = positionValue / collateralValue;
  return Number.isFinite(derivedLeverage) && derivedLeverage > 0 ? derivedLeverage : null;
}

function triggerDirection(kind: PerpsTpslKind, side: PerpsTpslPositionBasis["side"]) {
  const profitDirection = side === "long" ? 1 : -1;
  return kind === "tp" ? profitDirection : -profitDirection;
}

/**
 * Converts a leveraged return target into a market trigger price. A positive
 * TP percentage targets profit, while a positive SL percentage targets loss.
 * Negative values remain supported so a stop can lock in an existing gain.
 */
export function tpslPercentToTriggerPrice(
  position: PerpsTpslPositionBasis,
  kind: PerpsTpslKind,
  percent: number
) {
  const entryPrice = positiveFinite(position.entryPrice);
  const leverage = resolvePerpsPositionLeverage(position);
  if (entryPrice === null || leverage === null || !Number.isFinite(percent)) return null;

  const priceMove = percent / 100 / leverage;
  const triggerPrice = entryPrice * (1 + triggerDirection(kind, position.side) * priceMove);
  return Number.isFinite(triggerPrice) && triggerPrice > 0 ? triggerPrice : null;
}

export function triggerPriceToTpslPercent(
  position: PerpsTpslPositionBasis,
  kind: PerpsTpslKind,
  triggerPrice: number
) {
  const entryPrice = positiveFinite(position.entryPrice);
  const leverage = resolvePerpsPositionLeverage(position);
  if (entryPrice === null || leverage === null || !Number.isFinite(triggerPrice) || triggerPrice <= 0) return null;

  const priceMove = triggerPrice / entryPrice - 1;
  const percent = priceMove * triggerDirection(kind, position.side) * leverage * 100;
  return Number.isFinite(percent) ? percent : null;
}
