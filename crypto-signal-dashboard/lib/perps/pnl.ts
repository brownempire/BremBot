import type { JupiterPerpsPosition, JupiterPerpsTrade } from "@/lib/jupiterPerps";
import { estimateNetExitPnl, realizedTradePnl } from "@/lib/perps/pnlAccounting";

export type PerpsPnlPoint = {
  t: number;
  v: number;
  trade?: PerpsPnlTradeDetails;
};

export type PerpsPnlTradeDetails = {
  id: string;
  positionPubkey: string | null;
  txHash: string | null;
  marketSymbol: string;
  side: JupiterPerpsTrade["side"];
  action: string;
  orderType: string;
  price: number | null;
  sizeUsd: number | null;
  collateralUsdDelta: number | null;
  feeUsd: number | null;
  pnlUsd: number;
  pnlPercentage: number | null;
  timestamp: number;
  cumulativePnlUsd: number;
  networkFeeUsd?: number | null;
};

export type PerpsPnlSummary = {
  points: PerpsPnlPoint[];
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  tradeCount: number;
  updatedAt: number;
  accountingComplete: boolean;
  pendingTradeCount: number;
};

function tradeTimestamp(trade: JupiterPerpsTrade) {
  return trade.createdAt ?? trade.lastUpdated ?? 0;
}

function tradeIdentity(trade: JupiterPerpsTrade) {
  const timestamp = tradeTimestamp(trade);
  return `${trade.txHash ?? trade.id}:${trade.positionPubkey ?? "position"}:${trade.action}:${timestamp}`;
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
    uniqueTrades.set(tradeIdentity(trade), trade);
  });
  const ordered = [...uniqueTrades.values()].sort((left, right) => tradeTimestamp(left) - tradeTimestamp(right));
  let realizedPnlUsd = 0;
  const points: PerpsPnlPoint[] = [];
  const settledEpisodes = new Set<string>();
  const pendingEpisodes = new Set<string>();
  ordered.forEach((trade) => {
    const accounting = realizedTradePnl(trade);
    if (!accounting || accounting.netPnlUsd === null) {
      if (!trade.pnlAccounting || trade.pnlAccounting.status === "reconciling") pendingEpisodes.add(trade.pnlAccounting?.episodeId ?? trade.id);
      return;
    }
    if (settledEpisodes.has(accounting.episodeId)) return;
    settledEpisodes.add(accounting.episodeId);
    realizedPnlUsd += accounting.netPnlUsd;
    points.push({
      t: tradeTimestamp(trade),
      v: Number(realizedPnlUsd.toFixed(6)),
      trade: {
        id: tradeIdentity(trade),
        positionPubkey: trade.positionPubkey,
        txHash: trade.txHash,
        marketSymbol: trade.marketSymbol,
        side: trade.side,
        action: trade.action,
        orderType: trade.orderType,
        price: trade.price,
        sizeUsd: trade.sizeUsd,
        collateralUsdDelta: trade.collateralUsdDelta,
        feeUsd: null,
        networkFeeUsd: accounting.networkFeeUsd ?? null,
        pnlUsd: Number(accounting.netPnlUsd.toFixed(6)),
        pnlPercentage: accounting.netRoePercent,
        timestamp: tradeTimestamp(trade),
        cumulativePnlUsd: Number(realizedPnlUsd.toFixed(6)),
      },
    });
  });
  // Only settled episodes enter realized history. Opening fees are already in
  // the shared open estimate and must not also be added as realized losses.
  const openEstimates = positions.map(estimateNetExitPnl);
  const unrealizedPnlUsd = openEstimates.reduce((sum, estimate) => sum + (estimate?.estimatedNetPnlUsd ?? 0), 0);
  const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  points.push({ t: now, v: Number(totalPnlUsd.toFixed(6)) });
  return {
    points,
    realizedPnlUsd: Number(realizedPnlUsd.toFixed(6)),
    unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(6)),
    totalPnlUsd: Number(totalPnlUsd.toFixed(6)),
    tradeCount: settledEpisodes.size,
    pendingTradeCount: pendingEpisodes.size,
    accountingComplete: pendingEpisodes.size === 0 && openEstimates.every(Boolean),
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
