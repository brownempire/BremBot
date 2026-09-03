import {
  fetchJupiterPerpsTradeHistory,
  type JupiterPerpsTrade,
  type JupiterPerpsTradeHistory,
} from "@/lib/jupiterPerps";
import { getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import { buildPerpsPnlSummary } from "@/lib/perps/pnl";
import { enrichPerpsPnlAccounting, loadAccountedPerpsSnapshot } from "@/lib/perps/pnlAccountingServer";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";

export const dynamic = "force-dynamic";

type HistoryCacheEntry = {
  history: JupiterPerpsTradeHistory;
  fullRefreshAfter: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __brembotPerpsPnlHistory: Map<string, HistoryCacheEntry> | undefined;
}

function getHistoryCache() {
  if (!global.__brembotPerpsPnlHistory) global.__brembotPerpsPnlHistory = new Map();
  return global.__brembotPerpsPnlHistory;
}

function tradeKey(trade: JupiterPerpsTrade) {
  return `${trade.txHash ?? trade.id}:${trade.positionPubkey ?? "position"}:${trade.action}:${trade.createdAt ?? trade.lastUpdated ?? 0}`;
}

async function getPerpsHistory(walletAddress: string) {
  const cache = getHistoryCache();
  const cached = cache.get(walletAddress);
  if (!cached || cached.fullRefreshAfter <= Date.now()) {
    const history = await fetchJupiterPerpsTradeHistory(walletAddress);
    cache.set(walletAddress, { history, fullRefreshAfter: Date.now() + 15 * 60_000 });
    return history;
  }

  const latest = await fetchJupiterPerpsTradeHistory(walletAddress, { maxTrades: 100 });
  const trades = new Map(cached.history.trades.map((trade) => [tradeKey(trade), trade]));
  latest.trades.forEach((trade) => trades.set(tradeKey(trade), trade));
  const history = {
    trades: [...trades.values()],
    totalCount: Math.max(cached.history.totalCount, latest.totalCount),
    complete: cached.history.complete && trades.size >= latest.totalCount,
  };
  cache.set(walletAddress, { history, fullRefreshAfter: cached.fullRefreshAfter });
  return history;
}

export async function GET(request: Request) {
  const ownerWalletAddress = await getAuthorizedWalletAddress(request);
  if (!ownerWalletAddress) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const role = new URL(request.url).searchParams.get("walletRole") === "agent" ? "agent" : "primary";
  const walletAddress = role === "agent" ? getAgentWalletForOwner(ownerWalletAddress) : ownerWalletAddress;
  if (!walletAddress) {
    return Response.json({
      available: false,
      role,
      message: "No associated agent wallet is configured.",
    });
  }

  try {
    const [snapshot, history] = await Promise.all([
      loadAccountedPerpsSnapshot(walletAddress),
      getPerpsHistory(walletAddress),
    ]);
    const accounted = await enrichPerpsPnlAccounting(walletAddress, snapshot, history.trades);
    return Response.json({
      available: true,
      role,
      walletAddress,
      historyComplete: history.complete,
      historyTotalCount: history.totalCount,
      ...buildPerpsPnlSummary(accounted.recentTrades, accounted.positions),
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Unable to calculate Perps PnL.",
    }, { status: 502 });
  }
}
