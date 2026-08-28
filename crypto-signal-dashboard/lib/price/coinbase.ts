import type { PricePoint } from "@/lib/price/simulated";

export type CoinbasePricePayload = {
  source: "coinbase";
  markets: Record<string, { price: number; change24hPercent?: number }>;
  timestamp: number;
};

type CoinbaseTicker = {
  price?: string;
  bid?: string;
  ask?: string;
  volume?: string;
  time?: string;
  open?: string;
  open_24h?: string;
};

type CoinbaseStats = {
  open?: string;
};

type CoinbaseCandle = [number, number, number, number, number, number];
type CoinbaseTrade = { side?: "buy" | "sell"; size?: string };

const COINBASE_API = "https://api.exchange.coinbase.com";

export type CoinbaseLiveMarketSample = {
  price: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  observedAt: number;
  spreadBps: number | null;
  /** Signed aggressive-flow imbalance: +1 buy pressure, -1 sell pressure. */
  tradeImbalance?: number | null;
  tradeCount?: number;
};

export async function fetchCoinbaseLiveMarketSample(product: string): Promise<CoinbaseLiveMarketSample | null> {
  const request = (path: string) => fetch(`${COINBASE_API}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const [response, tradesResponse] = await Promise.all([
    request(`/products/${product}/ticker`),
    request(`/products/${product}/trades?limit=50`).catch(() => null),
  ]);
  if (!response.ok) return null;
  const ticker = (await response.json()) as CoinbaseTicker;
  const price = Number(ticker?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const bidValue = Number(ticker?.bid);
  const askValue = Number(ticker?.ask);
  const volumeValue = Number(ticker?.volume);
  const bid = Number.isFinite(bidValue) && bidValue > 0 ? bidValue : null;
  const ask = Number.isFinite(askValue) && askValue > 0 ? askValue : null;
  const midpoint = bid && ask ? (bid + ask) / 2 : null;
  const spreadBps = midpoint && ask! >= bid!
    ? (ask! - bid!) / midpoint * 10_000
    : null;
  const timestamp = Date.parse(ticker?.time ?? "");
  const trades = tradesResponse?.ok
    ? await tradesResponse.json().catch(() => []) as CoinbaseTrade[]
    : [];
  // Coinbase Exchange reports the maker side. A maker sell is therefore an
  // aggressive buy, and a maker buy is an aggressive sell.
  let aggressiveBuyVolume = 0;
  let aggressiveSellVolume = 0;
  trades.forEach((trade) => {
    const size = Number(trade.size);
    if (!Number.isFinite(size) || size <= 0) return;
    if (trade.side === "sell") aggressiveBuyVolume += size;
    if (trade.side === "buy") aggressiveSellVolume += size;
  });
  const totalAggressiveVolume = aggressiveBuyVolume + aggressiveSellVolume;
  return {
    price,
    bid,
    ask,
    volume: Number.isFinite(volumeValue) && volumeValue >= 0 ? volumeValue : null,
    observedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
    spreadBps: spreadBps === null ? null : Number(spreadBps.toFixed(6)),
    tradeImbalance: totalAggressiveVolume > 0
      ? Number(((aggressiveBuyVolume - aggressiveSellVolume) / totalAggressiveVolume).toFixed(6))
      : null,
    tradeCount: trades.length,
  };
}

export async function fetchCoinbaseLivePrice(product: string) {
  return (await fetchCoinbaseLiveMarketSample(product))?.price ?? null;
}

async function fetchCoinbasePriceEntry(product: string) {
  const [tickerResponse, statsResponse] = await Promise.all([
    fetch(`${COINBASE_API}/products/${product}/ticker`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
    fetch(`${COINBASE_API}/products/${product}/stats`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
  ]);

  if (!tickerResponse.ok || !statsResponse.ok) return null;

  const ticker = (await tickerResponse.json()) as CoinbaseTicker;
  const stats = (await statsResponse.json()) as CoinbaseStats;
  const price = Number(ticker?.price);
  const open24h = Number(stats?.open ?? ticker?.open_24h ?? ticker?.open);
  if (!Number.isFinite(price) || price <= 0) return null;

  const change24hPercent =
    Number.isFinite(open24h) && open24h > 0 ? ((price - open24h) / open24h) * 100 : undefined;

  return { price, change24hPercent };
}
export async function fetchCoinbasePrices(products: string[]): Promise<CoinbasePricePayload | null> {
  const markets: Record<string, { price: number; change24hPercent?: number }> = {};
  const entries = await Promise.all(
    products.map(async (product) => [product, await fetchCoinbasePriceEntry(product)] as const)
  );

  for (const [product, entry] of entries) {
    if (!entry) return null;
    markets[product] = entry;
  }

  return { source: "coinbase", markets, timestamp: Date.now() };
}

export async function fetchCoinbaseMinuteCandles(product: string, lookbackMinutes: number): Promise<PricePoint[]> {
  const safeLookback = Math.min(240, Math.max(10, Math.ceil(lookbackMinutes)));
  const end = new Date();
  const start = new Date(end.getTime() - safeLookback * 60_000);
  const query = new URLSearchParams({
    granularity: "60",
    start: start.toISOString(),
    end: end.toISOString(),
  });
  const response = await fetch(`${COINBASE_API}/products/${product}/candles?${query.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Coinbase candle request failed with HTTP ${response.status}.`);
  }

  const raw = (await response.json()) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("Coinbase returned an invalid candle response.");
  }

  return parseCompletedCoinbaseMinuteCandles(raw, end.getTime());
}

export function parseCompletedCoinbaseMinuteCandles(raw: unknown, observedAt = Date.now()): PricePoint[] {
  if (!Array.isArray(raw)) return [];
  const currentMinuteStartedAt = Math.floor(observedAt / 60_000) * 60_000;

  return raw
    .flatMap((entry) => {
      if (!Array.isArray(entry) || entry.length < 5) return [];
      const candle = entry as CoinbaseCandle;
      const timestamp = Number(candle[0]) * 1000;
      const low = Number(candle[1]);
      const high = Number(candle[2]);
      const open = Number(candle[3]);
      const close = Number(candle[4]);
      const volume = Number(candle[5]);
      return Number.isFinite(timestamp)
        && timestamp < currentMinuteStartedAt
        && Number.isFinite(close)
        && close > 0
        ? [{
            t: timestamp,
            v: close,
            o: Number.isFinite(open) && open > 0 ? open : undefined,
            h: Number.isFinite(high) && high > 0 ? high : undefined,
            l: Number.isFinite(low) && low > 0 ? low : undefined,
            volume: Number.isFinite(volume) && volume >= 0 ? volume : undefined,
          }]
        : [];
    })
    .sort((left, right) => left.t - right.t);
}
