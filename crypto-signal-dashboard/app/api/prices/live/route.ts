type PricePayload = {
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

async function fetchCoinbasePriceEntry(product: string) {
  const [tickerResponse, statsResponse] = await Promise.all([
    fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    }),
    fetch(`https://api.exchange.coinbase.com/products/${product}/stats`, {
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

async function fetchCoinbasePrices(products: string[]): Promise<PricePayload | null> {
  const markets: Record<string, { price: number; change24hPercent?: number }> = {};

  const entries = await Promise.all(products.map(async (product) => [product, await fetchCoinbasePriceEntry(product)] as const));

  for (const [product, entry] of entries) {
    if (!entry) return null;
    markets[product] = entry;
  }

  return {
    source: "coinbase",
    markets,
    timestamp: Date.now(),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const productsParam = url.searchParams.get("products");
  const products = (productsParam ? productsParam.split(",") : ["SOL-USD", "ETH-USD", "BTC-USD"])
    .map((product) => product.trim().toUpperCase())
    .filter((product) => /^[A-Z0-9]+-[A-Z0-9]+$/.test(product))
    .slice(0, 6);

  if (products.length === 0) {
    return new Response(JSON.stringify({ error: "No valid products requested" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // TradingView chart is configured with COINBASE symbols.
  // Keep the real-time feed locked to Coinbase so chart + signal engine + cards stay in sync.
  const coinbase = await fetchCoinbasePrices(products).catch(() => null);
  if (coinbase) {
    return new Response(JSON.stringify(coinbase), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ error: "Coinbase price source unavailable" }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }
  );
}
