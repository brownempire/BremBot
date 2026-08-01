export type PositionOverlayGuide = {
  id: string;
  label: string;
  price: number;
  tone: "entry" | "tp" | "sl" | "liquidation";
};

export type PositionGuideSource = {
  id: string;
  entryPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  liquidationPrice: number | null;
  unrealizedPnl?: number | null;
};

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
      { suffix: "entry", label: "Entry", price: position.entryPrice, tone: "entry" },
      { suffix: "tp", label: "TP", price: position.takeProfit, tone: "tp" },
      {
        suffix: "liquidation",
        label: "Liq",
        price: position.liquidationPrice,
        tone: "liquidation",
      },
      { suffix: "sl", label: "SL", price: position.stopLoss, tone: "sl" },
    ] as const;

    levels.forEach((level) => {
      if (typeof level.price !== "number" || !Number.isFinite(level.price) || level.price <= 0) {
        return;
      }
      guides.push({
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
