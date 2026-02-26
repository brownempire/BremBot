type CoinbaseProduct = {
  id?: string;
  base_currency?: string;
  quote_currency?: string;
  status?: string;
  trading_disabled?: boolean;
  cancel_only?: boolean;
  limit_only?: boolean;
  post_only?: boolean;
};

type MarketOption = {
  coinbaseProduct: string;
  pair: string;
  tvSymbol: string;
};

function toTvCoinbaseSymbol(product: string) {
  return `COINBASE:${product.replace("-", "")}`;
}

const DEFAULT_OPTIONS: MarketOption[] = [
  { coinbaseProduct: "SOL-USD", pair: "SOL/USD", tvSymbol: "COINBASE:SOLUSD" },
  { coinbaseProduct: "ETH-USD", pair: "ETH/USD", tvSymbol: "COINBASE:ETHUSD" },
  { coinbaseProduct: "BTC-USD", pair: "BTC/USD", tvSymbol: "COINBASE:BTCUSD" },
];

export async function GET() {
  const response = await fetch("https://api.exchange.coinbase.com/products", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  }).catch(() => null);

  if (!response?.ok) {
    return new Response(JSON.stringify({ options: DEFAULT_OPTIONS, source: "fallback" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const raw = (await response.json()) as CoinbaseProduct[];
  const options: MarketOption[] = (Array.isArray(raw) ? raw : [])
    .filter((item) => item.id && item.base_currency && item.quote_currency)
    .filter((item) => item.quote_currency === "USD")
    .filter((item) => item.status?.toLowerCase() === "online")
    .filter((item) => !item.trading_disabled && !item.cancel_only && !item.limit_only && !item.post_only)
    .map((item) => ({
      coinbaseProduct: item.id as string,
      pair: `${item.base_currency}/${item.quote_currency}`,
      tvSymbol: toTvCoinbaseSymbol(item.id as string),
    }))
    .sort((a, b) => a.pair.localeCompare(b.pair))
    .slice(0, 500);

  return new Response(JSON.stringify({ options: options.length > 0 ? options : DEFAULT_OPTIONS, source: "coinbase" }), {
    headers: { "Content-Type": "application/json" },
  });
}
