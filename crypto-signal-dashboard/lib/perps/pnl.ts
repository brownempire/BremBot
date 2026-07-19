import type { JupiterPerpsPosition, JupiterPerpsTrade } from "@/lib/jupiterPerps";

export type PerpsPnlPoint = {
  t: number;
  v: number;
};

export type PerpsPnlSummary = {
  points: PerpsPnlPoint[];
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  tradeCount: number;
  updatedAt: number;
};

function tradeTimestamp(trade: JupiterPerpsTrade) {
  return trade.createdAt ?? trade.lastUpdated ?? 0;
}

function tradePnlDelta(trade: JupiterPerpsTrade) {
  if (typeof trade.pnl === "number" && Number.isFinite(trade.pnl)) return trade.pnl;
  if (typeof trade.feeUsd === "number" && Number.isFinite(trade.feeUsd)) return -Math.max(0, trade.feeUsd);
  return 0;
}

export function buildPerpsPnlSummary(
  trades: JupiterPerpsTrade[],
  positions: JupiterPerpsPosition[],
  now = Date.now()
): PerpsPnlSummary {
  const uniqueTrades = new Map<string, JupiterPerpsTrade>();
  trades.forEach((trade) => {
    const timestamp = tradeTimestamp(trade);
    if (timestamp <= 0) return;
    const key = `${trade.txHash ?? trade.id}:${trade.positionPubkey ?? "position"}:${trade.action}:${timestamp}`;
    uniqueTrades.set(key, trade);
  });
  const ordered = [...uniqueTrades.values()].sort((left, right) => tradeTimestamp(left) - tradeTimestamp(right));
  let realizedPnlUsd = 0;
  const points: PerpsPnlPoint[] = [];
  ordered.forEach((trade) => {
    realizedPnlUsd += tradePnlDelta(trade);
    points.push({
      t: tradeTimestamp(trade),
      v: Number(realizedPnlUsd.toFixed(6)),
    });
  });
  const unrealizedPnlUsd = positions.reduce((sum, position) => (
    sum + (typeof position.unrealizedPnl === "number" && Number.isFinite(position.unrealizedPnl) ? position.unrealizedPnl : 0)
  ), 0);
  const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  points.push({ t: now, v: Number(totalPnlUsd.toFixed(6)) });
  return {
    points,
    realizedPnlUsd: Number(realizedPnlUsd.toFixed(6)),
    unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(6)),
    totalPnlUsd: Number(totalPnlUsd.toFixed(6)),
    tradeCount: ordered.length,
    updatedAt: now,
  };
}

export function calculatePnlSince(points: PerpsPnlPoint[], cutoff: number) {
  if (points.length === 0) return 0;
  const ordered = [...points].sort((left, right) => left.t - right.t);
  const latest = ordered[ordered.length - 1]?.v ?? 0;
  let baseline = 0;
  for (const point of ordered) {
    if (point.t >= cutoff) break;
    baseline = point.v;
  }
  return Number((latest - baseline).toFixed(6));
}
