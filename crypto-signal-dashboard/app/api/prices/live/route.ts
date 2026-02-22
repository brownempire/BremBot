type AppSymbol = "SOL/USD" | "ETH/USD" | "BTC/USD";

type PricePayload = {
  source: "chaos_edge" | "coinbase";
  prices: Record<AppSymbol, number>;
  timestamp: number;
};

const SYMBOLS: AppSymbol[] = ["SOL/USD", "ETH/USD", "BTC/USD"];

const CHAOS_BASE_URL = process.env.CHAOS_EDGE_BASE_URL ?? "https://api.edge-inference.chaoslabs.xyz";
const CHAOS_API_KEY = process.env.CHAOS_EDGE_API_KEY;

const CHAOS_FEEDS: Record<AppSymbol, string | undefined> = {
  "SOL/USD": process.env.CHAOS_EDGE_FEED_SOL_USD,
  "ETH/USD": process.env.CHAOS_EDGE_FEED_ETH_USD,
  "BTC/USD": process.env.CHAOS_EDGE_FEED_BTC_USD,
};

async function fetchChaosEdgePrices(): Promise<PricePayload | null> {
  const feedIds = SYMBOLS.map((symbol) => CHAOS_FEEDS[symbol]).filter(Boolean) as string[];
  if (!CHAOS_API_KEY || feedIds.length !== SYMBOLS.length) return null;

  const url = `${CHAOS_BASE_URL}/prices/batch?feedIds=${feedIds.join(",")}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${CHAOS_API_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) return null;

  const raw = await response.json();
  const items: Array<{ feedId?: string; price?: number | string }> = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.prices)
      ? raw.prices
      : [];

  const feedToSymbol = new Map<string, AppSymbol>();
  SYMBOLS.forEach((symbol) => {
    const feedId = CHAOS_FEEDS[symbol];
    if (feedId) feedToSymbol.set(feedId, symbol);
  });

  const prices: Partial<Record<AppSymbol, number>> = {};
  for (const item of items) {
    const symbol = item.feedId ? feedToSymbol.get(item.feedId) : undefined;
    if (!symbol) continue;
    const value = Number(item.price);
    if (Number.isFinite(value) && value > 0) {
      prices[symbol] = value;
    }
  }

  if (!SYMBOLS.every((symbol) => typeof prices[symbol] === "number")) return null;

  return {
    source: "chaos_edge",
    prices: prices as Record<AppSymbol, number>,
    timestamp: Date.now(),
  };
}

async function fetchCoinbasePrices(): Promise<PricePayload | null> {
  const coinbaseProducts: Record<AppSymbol, string> = {
    "SOL/USD": "SOL-USD",
    "ETH/USD": "ETH-USD",
    "BTC/USD": "BTC-USD",
  };

  const prices: Partial<Record<AppSymbol, number>> = {};

  for (const symbol of SYMBOLS) {
    const product = coinbaseProducts[symbol];
    // Use Coinbase Exchange ticker so the box prices align more closely with TradingView COINBASE:* symbols.
    const response = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
      cache: "no-store",
      headers: {
        "Accept": "application/json",
      },
    });
    if (!response.ok) return null;
    const raw = await response.json();
    const price = Number(raw?.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    prices[symbol] = price;
  }

  return {
    source: "coinbase",
    prices: prices as Record<AppSymbol, number>,
    timestamp: Date.now(),
  };
}

export async function GET() {
  // Keep box prices aligned with the visible TradingView COINBASE chart.
  // If Chaos Edge is configured but drifts from the chart source, Coinbase remains the fallback/consistency source.
  const chaos = await fetchChaosEdgePrices().catch(() => null);
  if (chaos) {
    return new Response(JSON.stringify(chaos), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const coinbase = await fetchCoinbasePrices().catch(() => null);
  if (coinbase) {
    return new Response(JSON.stringify(coinbase), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ error: "No price source available (Chaos Edge and Coinbase unavailable)" }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }
  );
}
