import type { PerpsPnlPoint } from "@/lib/perps/pnl";

export type PnlChartDomain = {
  start: number;
  end: number;
};

const MIN_VISIBLE_SPAN_MS = 60_000;

export function normalizePnlChartDomain(domain: PnlChartDomain, bounds: PnlChartDomain): PnlChartDomain {
  const boundsSpan = Math.max(MIN_VISIBLE_SPAN_MS, bounds.end - bounds.start);
  const requestedSpan = Math.min(boundsSpan, Math.max(MIN_VISIBLE_SPAN_MS, domain.end - domain.start));
  const start = Math.min(bounds.end - requestedSpan, Math.max(bounds.start, domain.start));
  return { start, end: start + requestedSpan };
}

export function zoomPnlChartDomain(
  domain: PnlChartDomain,
  bounds: PnlChartDomain,
  anchorRatio: number,
  scale: number
): PnlChartDomain {
  const ratio = Math.min(1, Math.max(0, anchorRatio));
  const span = Math.max(MIN_VISIBLE_SPAN_MS, domain.end - domain.start);
  const nextSpan = span * Math.max(0.1, scale);
  const anchor = domain.start + span * ratio;
  return normalizePnlChartDomain({
    start: anchor - nextSpan * ratio,
    end: anchor + nextSpan * (1 - ratio),
  }, bounds);
}

export function panPnlChartDomain(
  domain: PnlChartDomain,
  bounds: PnlChartDomain,
  deltaRatio: number
): PnlChartDomain {
  const span = Math.max(MIN_VISIBLE_SPAN_MS, domain.end - domain.start);
  const delta = span * deltaRatio;
  return normalizePnlChartDomain({
    start: domain.start + delta,
    end: domain.end + delta,
  }, bounds);
}

export function pnlPointsForRange(points: PerpsPnlPoint[], cutoff: number, now: number) {
  const ordered = points
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    .sort((left, right) => left.t - right.t);
  let baseline = 0;
  for (const point of ordered) {
    if (point.t >= cutoff) break;
    baseline = point.v;
  }
  const ranged = ordered.filter((point) => point.t >= cutoff && point.t <= now);
  const pointsInRange = [
    { t: cutoff, v: baseline },
    ...ranged,
  ];
  if ((pointsInRange.at(-1)?.t ?? 0) < now) {
    pointsInRange.push({ t: now, v: pointsInRange.at(-1)?.v ?? baseline });
  }
  return pointsInRange;
}
