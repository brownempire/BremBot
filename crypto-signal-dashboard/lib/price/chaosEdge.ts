export type ChaosEdgePrice = {
  symbol: string;
  price: number;
};

const CHAOS_EDGE_URL = process.env.NEXT_PUBLIC_CHAOS_EDGE_URL;
const CHAOS_EDGE_TOKEN = process.env.NEXT_PUBLIC_CHAOS_EDGE_TOKEN;

export async function fetchChaosEdgePrices(symbols: string[]): Promise<ChaosEdgePrice[] | null> {
  if (!CHAOS_EDGE_URL || !CHAOS_EDGE_TOKEN) return null;

  const response = await fetch(CHAOS_EDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHAOS_EDGE_TOKEN}`,
    },
    body: JSON.stringify({ symbols }),
    cache: "no-store",
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!Array.isArray(data?.prices)) return null;

  return data.prices.map((entry: any) => ({
    symbol: String(entry.symbol ?? ""),
    price: Number(entry.price ?? 0),
  }));
}
