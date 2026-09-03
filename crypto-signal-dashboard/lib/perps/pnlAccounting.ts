import type { JupiterPerpsPosition, JupiterPerpsTrade } from "@/lib/jupiterPerps";
import { DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE } from "@/lib/perps/scalpExit";

export type RealizedPnlAccounting = {
  version: 1;
  episodeId: string;
  status: "reconciling" | "reconciled" | "open" | "included";
  reason?: string;
  netPnlUsd: number | null;
  netRoePercent: number | null;
  capitalUsd: number | null;
  cashflowUsdc?: number;
  networkFeeSol?: number;
  networkFeeUsd?: number;
  feeConversionSolUsd?: number;
  feeConversionSource?: string;
  signatures?: string[];
  asOf: number;
};

export type OpenPnlAccounting = {
  capitalUsd: number;
  // Difference between actual wallet funding and provider-reported funding.
  // Covers entry swaps/rounding not present in the live after-fee field.
  fundingAdjustmentUsd: number;
  paidNetworkFeesUsd: number;
  asOf: number;
};

export type NetExitSource = Pick<JupiterPerpsPosition,
  "entryPrice" | "positionValue" | "positionSize" | "unrealizedPnl" | "collateralValue"
> & { source?: string | null; pnlCostBasis?: OpenPnlAccounting | null };

/** One presentation definition: estimated cash profit if closed now.
 * The live API already carries opening fees and borrow accrued over the actual
 * holding period. Do not charge those a second time. Reserve the remaining
 * observed all-in rate for exit, impact, swap, slippage and short borrow drift.
 * Gross-only fallback feeds cannot tell us accrued borrowing; suppress their
 * net figure until the fee-bearing feed returns. Never invent a holding time.
 */
export function estimateNetExitPnl(position: NetExitSource) {
  if (["rpc-direct", "rpc-placeholder", "portfolio-api"].includes(position.source ?? "")) return null;
  const pnl = position.unrealizedPnl;
  const notional = position.positionValue ?? (
    position.entryPrice && position.positionSize ? Math.abs(position.entryPrice * position.positionSize) : null
  );
  if (pnl == null || !Number.isFinite(pnl) || notional == null || !Number.isFinite(notional) || notional <= 0) return null;
  const remainingRate = position.source === "live-api"
    ? Math.max(0, DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE - 0.0006)
    : DEFAULT_CONSERVATIVE_PERPS_ROUND_TRIP_FEE_RATE;
  const remainingCosts = notional * remainingRate + 0.01;
  const paidCosts = (position.pnlCostBasis?.fundingAdjustmentUsd ?? 0)
    + (position.pnlCostBasis?.paidNetworkFeesUsd ?? 0);
  const net = pnl - paidCosts - remainingCosts;
  const capital = position.pnlCostBasis?.capitalUsd ?? position.collateralValue;
  return {
    estimatedExitCostsUsd: Number(remainingCosts.toFixed(2)),
    estimatedNetPnlUsd: Number(net.toFixed(2)),
    // Same rounded dollar numerator on every surface.
    estimatedNetRoePercent: capital != null && Number.isFinite(capital) && capital > 0
      ? Number((Number(net.toFixed(2)) / capital * 100).toFixed(2)) : null,
    capitalUsd: capital,
  };
}

export function projectedNetExitPnl(position: JupiterPerpsPosition, target: number | null | undefined) {
  const estimate = estimateNetExitPnl(position);
  if (!estimate || target == null || !Number.isFinite(target) || position.markPrice == null || position.positionSize == null) return null;
  const delta = (target - position.markPrice) * position.positionSize * (position.side === "short" ? -1 : 1);
  return Number((estimate.estimatedNetPnlUsd + delta).toFixed(2));
}

/** Aggregate exactly the visible positions; do not silently omit unavailable rows. */
export function summarizeNetExitPnl(positions: readonly NetExitSource[]) {
  if (!positions.length) return null;
  const estimates = positions.map(estimateNetExitPnl);
  if (estimates.some(e=>e === null)) return null;
  const net = Number(estimates.reduce((sum,e)=>sum+e!.estimatedNetPnlUsd,0).toFixed(2));
  const validCapital = estimates.every(e=>e!.capitalUsd != null && Number.isFinite(e!.capitalUsd) && e!.capitalUsd! > 0);
  const capital = validCapital ? estimates.reduce((sum,e)=>sum+e!.capitalUsd!,0) : null;
  return {estimatedNetPnlUsd:net, estimatedNetRoePercent:capital ? Number((net/capital*100).toFixed(2)) : null};
}

export function realizedTradePnl(trade: JupiterPerpsTrade) {
  const accounting = trade.pnlAccounting;
  return accounting?.status === "reconciled" ? accounting : null;
}

export type PnlEpisode = {
  id: string; position: string; trades: JupiterPerpsTrade[]; openedAt: number;
  closedAt: number | null; nextOpenedAt?: number;
};

/** Separate reused position PDAs, deduplicate history, and keep scale-ins and
 * partial exits in one episode. A partial close never emits final profit. */
export function groupPnlEpisodes(trades: readonly JupiterPerpsTrade[]): PnlEpisode[] {
  const unique = new Map(trades.map(t => [`${t.txHash ?? t.id}:${t.positionPubkey}:${t.action}:${t.createdAt}`, t]));
  const groups = new Map<string, JupiterPerpsTrade[]>();
  for (const trade of unique.values()) {
    if (!trade.positionPubkey || !trade.createdAt) continue;
    const rows = groups.get(trade.positionPubkey) ?? [];
    rows.push(trade); groups.set(trade.positionPubkey, rows);
  }
  const result: PnlEpisode[] = [];
  for (const [position, rows] of groups) {
    let episode: PnlEpisode | null = null;
    let size = 0;
    for (const trade of rows.sort((a,b) => a.createdAt! - b.createdAt!)) {
      const opening = /increase|open/i.test(trade.action) && !/close/i.test(trade.action);
      if (!episode && !opening) continue; // Truncated history is not an episode.
      if (!episode) {
        const previous = result.filter(x => x.position === position).at(-1);
        if (previous) previous.nextOpenedAt = trade.createdAt!;
        episode = { id: `${position}:${trade.txHash ?? trade.id}`, position, trades: [], openedAt: trade.createdAt!, closedAt: null };
        result.push(episode); size = 0;
      }
      episode.trades.push(trade);
      if (opening) size += trade.sizeUsd ?? Number.POSITIVE_INFINITY;
      else if (/decrease|close|liquidat/i.test(trade.action)) {
        size -= trade.sizeUsd ?? 0;
        if (/close|liquidat/i.test(trade.action) || (Number.isFinite(size) && size <= 0.02)) {
          episode.closedAt = trade.createdAt!; episode = null;
        }
      }
    }
  }
  return result.sort((a,b) => b.openedAt - a.openedAt);
}
