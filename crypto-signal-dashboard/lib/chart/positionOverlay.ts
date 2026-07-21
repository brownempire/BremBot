import type { PricePoint } from "@/lib/price/simulated";

export type PositionOverlayGuide = {
  id: string;
  label: string;
  price: number;
  tone: "entry" | "tp" | "sl" | "liquidation";
};

export type PositionOverlayScale = {
  paneTop: number;
  paneBottom: number;
  minPrice: number;
  maxPrice: number;
};

export type PositionedOverlayGuide = PositionOverlayGuide & {
  top: number;
  edge: "above" | "below" | null;
};

const MIN_SCALE_SPAN = 1e-6;

export function getOverlayIntervalWindowMs(interval: string) {
  const normalized = interval.trim().toUpperCase();
  if (normalized === "1") return 60 * 60 * 1000;
  if (normalized === "3") return 3 * 60 * 60 * 1000;
  if (normalized === "5") return 6 * 60 * 60 * 1000;
  if (normalized === "15") return 18 * 60 * 60 * 1000;
  if (normalized === "30") return 24 * 60 * 60 * 1000;
  if (normalized === "60" || normalized === "1H") return 3 * 24 * 60 * 60 * 1000;
  if (normalized === "120" || normalized === "2H") return 5 * 24 * 60 * 60 * 1000;
  if (normalized === "240" || normalized === "4H") return 10 * 24 * 60 * 60 * 1000;
  if (normalized === "1D" || normalized === "D") return 45 * 24 * 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
}

export function validOverlayGuides(guides: PositionOverlayGuide[] | undefined) {
  return (guides ?? []).filter(
    (guide): guide is PositionOverlayGuide =>
      Boolean(guide?.id) && Boolean(guide?.label) && Number.isFinite(guide?.price) && guide.price > 0
  );
}

export function buildPositionOverlayScale({
  frameHeight,
  pricePoints,
  guides,
  interval,
}: {
  frameHeight: number;
  pricePoints: PricePoint[];
  guides: PositionOverlayGuide[] | undefined;
  interval: string;
}): PositionOverlayScale | null {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return null;

  const validPoints = pricePoints.filter(
    (point): point is PricePoint => Number.isFinite(point.t) && Number.isFinite(point.v) && point.v > 0
  );
  const guidePrices = validOverlayGuides(guides).map((guide) => guide.price);

  const latestTimestamp = validPoints.reduce((latest, point) => Math.max(latest, point.t), 0);
  const visiblePoints = validPoints.filter(
    (point) => point.t >= latestTimestamp - getOverlayIntervalWindowMs(interval)
  );
  const effectivePoints = visiblePoints.length >= 8 ? visiblePoints : validPoints.slice(-240);
  // TradingView auto-scales against its candles, not our HTML guide labels. Keep the
  // fallback scale candle-led so an in-range guide maps to the correct part of the chart.
  const scaleValues = effectivePoints.length > 0
    ? effectivePoints.map((point) => point.v)
    : guidePrices;

  if (scaleValues.length === 0) return null;

  const minPrice = Math.min(...scaleValues);
  const maxPrice = Math.max(...scaleValues);
  const midpoint = Math.max((minPrice + maxPrice) / 2, MIN_SCALE_SPAN);
  const span = Math.max(maxPrice - minPrice, midpoint * 0.006, MIN_SCALE_SPAN);
  const verticalPadding = span * 0.12;
  const paneTop = Math.min(90, Math.max(54, frameHeight * 0.105));
  const paneBottom = Math.max(
    paneTop + Math.min(120, frameHeight * 0.5),
    frameHeight - Math.min(42, Math.max(26, frameHeight * 0.055))
  );

  return {
    paneTop,
    paneBottom: Math.min(frameHeight - 8, paneBottom),
    minPrice: minPrice - verticalPadding,
    maxPrice: maxPrice + verticalPadding,
  };
}

export function positionOverlayGuides(
  guides: PositionOverlayGuide[] | undefined,
  scale: PositionOverlayScale,
  frameHeight: number
): PositionedOverlayGuide[] {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return [];

  const paneHeight = Math.max(scale.paneBottom - scale.paneTop, 1);
  const scaleSpan = Math.max(scale.maxPrice - scale.minPrice, MIN_SCALE_SPAN);
  const edgeInset = Math.min(10, paneHeight * 0.03);

  return validOverlayGuides(guides).map((guide) => {
    const edge = guide.price > scale.maxPrice
      ? "above"
      : guide.price < scale.minPrice
        ? "below"
        : null;
    const relative = (guide.price - scale.minPrice) / scaleSpan;
    const unclampedY = scale.paneTop + (1 - relative) * paneHeight;
    const y = Math.min(
      scale.paneBottom - edgeInset,
      Math.max(scale.paneTop + edgeInset, unclampedY)
    );

    return {
      ...guide,
      top: (y / frameHeight) * 100,
      edge,
    };
  });
}
