import type { PricePoint } from "@/lib/price/simulated";

export type CoinbasePricePayload = {
  source: "coinbase";
  markets: Record<string, { price: number; change24hPercent?: number }>;
  timestamp: number;
};

type CoinbaseTicker = {
  price?: string;
  open?: string;
  open_24h?: string;
};

type CoinbaseStats = {
  open?: string;
};

type CoinbaseCandle = [number, number, number, number, number, number];

const COINBASE_API = "https://api.exchange.coinbase.com";

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
