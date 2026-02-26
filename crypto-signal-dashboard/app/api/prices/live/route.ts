type PricePayload = {
  source: "coinbase" | "coingecko";
  markets: Record<string, { price: number; change24hPercent: number }>;
  timestamp: number;
};

const COINGECKO_BASE_TO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  LTC: "litecoin",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  LINK: "chainlink",
  UNI: "uniswap",
  MATIC: "matic-network",
};
async function fetchCoinbasePrices(products: string[]): Promise<PricePayload | null> {
  const markets: Record<string, { price: number; change24hPercent: number }> = {};

  for (const product of products) {
    const response = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
      cache: "no-store",
      headers: {
        "Accept": "application/json",
      },
    });
    if (!response.ok) return null;
    const raw = await response.json();
    const price = Number(raw?.price);
    const open24h = Number(raw?.open ?? raw?.open_24h);
    if (!Number.isFinite(price) || price <= 0) return null;
    const change24hPercent =
      Number.isFinite(open24h) && open24h > 0 ? ((price - open24h) / open24h) * 100 : 0;
    markets[product] = { price, change24hPercent };
  }

  return {
    source: "coinbase",
    markets,
    timestamp: Date.now(),
  };
}

async function fetchCoinGeckoPrices(products: string[]): Promise<PricePayload | null> {
  const productToCoinId = new Map<string, string>();

  products.forEach((product) => {
    const [base, quote] = product.split("-");
    if (!base || !quote) return;
    if (quote !== "USD" && quote !== "USDT") return;
    const coinId = COINGECKO_BASE_TO_ID[base];
    if (!coinId) return;
    productToCoinId.set(product, coinId);
  });

  if (productToCoinId.size === 0) {
    return null;
  }

  const coinIds = [...new Set(productToCoinId.values())];
  const endpoint = new URL("https://api.coingecko.com/api/v3/simple/price");
  endpoint.searchParams.set("ids", coinIds.join(","));
  endpoint.searchParams.set("vs_currencies", "usd");
  endpoint.searchParams.set("include_24hr_change", "true");

  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;

  const raw = (await response.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
  const markets: Record<string, { price: number; change24hPercent: number }> = {};

  productToCoinId.forEach((coinId, product) => {
    const entry = raw?.[coinId];
    const price = Number(entry?.usd);
    const change24hPercent = Number(entry?.usd_24h_change ?? 0);
    if (!Number.isFinite(price) || price <= 0) return;
    markets[product] = {
      price,
      change24hPercent: Number.isFinite(change24hPercent) ? change24hPercent : 0,
    };
  });

  if (Object.keys(markets).length === 0) {
    return null;
  }

  return {
    source: "coingecko",
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

  // Signal generation is calibrated against the visible TradingView COINBASE chart.
  // Use Coinbase directly here so chart + price boxes + signal engine share the same market source.
  const coinbase = await fetchCoinbasePrices(products).catch(() => null);
  if (coinbase) {
    return new Response(JSON.stringify(coinbase), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const coinGecko = await fetchCoinGeckoPrices(products).catch(() => null);
  if (coinGecko) {
    return new Response(JSON.stringify(coinGecko), {
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
