import { fetchCoinbasePrices } from "@/lib/price/coinbase";

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
