export type PositionOverlayGuide = {
  editable?: boolean;
  estimatedNetPnlUsd?: number | null;
  id: string;
  kind?: "tp" | "sl";
  label: string;
  pnlPerPriceUnit?: number | null;
  positionId?: string;
  price: number;
  tone: "entry" | "tp" | "sl" | "liquidation";
};

export type PositionGuideSource = {
  id: string;
  entryPrice: number | null;
  markPrice?: number | null;
  positionSize?: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  liquidationPrice: number | null;
  side?: "long" | "short";
  unrealizedPnl?: number | null;
};

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectedNetPnl(position: PositionGuideSource, targetPrice: number) {
  const markPrice = finite(position.markPrice);
  const positionSize = finite(position.positionSize);
  const unrealizedPnl = finite(position.unrealizedPnl);
  if (markPrice === null || positionSize === null || positionSize <= 0 || unrealizedPnl === null) {
    return null;
  }

  const pnlPerPriceUnit = position.side === "short" ? -positionSize : positionSize;
  return Number((unrealizedPnl + (targetPrice - markPrice) * pnlPerPriceUnit).toFixed(2));
}

export function summarizePositionOverlayPnl(
  positions: readonly PositionGuideSource[]
) {
  if (positions.length === 0) return null;

  const pnlValues = positions
    .map((position) => position.unrealizedPnl)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (pnlValues.length === 0) return null;
  return Number(pnlValues.reduce((sum, value) => sum + value, 0).toFixed(2));
}

export function buildPositionOverlayGuides(
  positions: readonly PositionGuideSource[]
): PositionOverlayGuide[] {
  const guides: PositionOverlayGuide[] = [];

  positions.forEach((position, index) => {
    const labelPrefix = positions.length > 1 ? `${index + 1} ` : "";
    const levels = [
      { suffix: "entry", label: "Entry", price: position.entryPrice, tone: "entry", kind: null },
      { suffix: "tp", label: "TP", price: position.takeProfit, tone: "tp", kind: "tp" },
      {
        suffix: "liquidation",
        label: "Liq",
        price: position.liquidationPrice,
        tone: "liquidation",
        kind: null,
      },
      { suffix: "sl", label: "SL", price: position.stopLoss, tone: "sl", kind: "sl" },
    ] as const;

    levels.forEach((level) => {
      if (typeof level.price !== "number" || !Number.isFinite(level.price) || level.price <= 0) {
        return;
      }
      guides.push({
        ...(level.kind
          ? {
              editable: true,
              estimatedNetPnlUsd: projectedNetPnl(position, level.price),
              kind: level.kind,
              pnlPerPriceUnit:
                typeof position.positionSize === "number" && Number.isFinite(position.positionSize)
                  ? (position.side === "short" ? -position.positionSize : position.positionSize)
                  : null,
              positionId: position.id,
            }
          : {}),
        id: `${position.id}-${level.suffix}`,
        label: `${labelPrefix}${level.label}`,
        price: level.price,
        tone: level.tone,
      });
    });
  });

  return guides;
}

export function validOverlayGuides(guides: PositionOverlayGuide[] | undefined) {
  return (guides ?? []).filter(
    (guide): guide is PositionOverlayGuide =>
      Boolean(guide?.id) && Boolean(guide?.label) && Number.isFinite(guide?.price) && guide.price > 0
  );
}

export function projectOverlayGuideNetPnl(guide: PositionOverlayGuide, price: number) {
  if (
    !Number.isFinite(price)
    || typeof guide.estimatedNetPnlUsd !== "number"
    || !Number.isFinite(guide.estimatedNetPnlUsd)
    || typeof guide.pnlPerPriceUnit !== "number"
    || !Number.isFinite(guide.pnlPerPriceUnit)
  ) {
    return null;
  }
  return Number((guide.estimatedNetPnlUsd + (price - guide.price) * guide.pnlPerPriceUnit).toFixed(2));
}
