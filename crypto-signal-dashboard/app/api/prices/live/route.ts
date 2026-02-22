import { Contract, JsonRpcProvider } from "ethers";

type AppSymbol = "SOL/USD" | "ETH/USD" | "BTC/USD";

type PricePayload = {
  source: "chaos_edge" | "chainlink" | "binance";
  prices: Record<AppSymbol, number>;
  timestamp: number;
};

const SYMBOLS: AppSymbol[] = ["SOL/USD", "ETH/USD", "BTC/USD"];
const BINANCE_SYMBOLS: Record<AppSymbol, string> = {
  "SOL/USD": "SOLUSDT",
  "ETH/USD": "ETHUSDT",
  "BTC/USD": "BTCUSDT",
};

const CHAINLINK_ETH_MAINNET_FEEDS: Record<AppSymbol, string> = {
  "SOL/USD": "0x4ffC43a60e009B551865A93d232E33Fce9f01507",
  "ETH/USD": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  "BTC/USD": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
};

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];

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

async function fetchChainlinkPrices(): Promise<PricePayload | null> {
  const rpcUrl = process.env.ETHEREUM_RPC_URL ?? process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL;
  if (!rpcUrl) return null;

  const provider = new JsonRpcProvider(rpcUrl);
  const prices: Partial<Record<AppSymbol, number>> = {};

  for (const symbol of SYMBOLS) {
    const address = CHAINLINK_ETH_MAINNET_FEEDS[symbol];
    const contract = new Contract(address, AGGREGATOR_ABI, provider);
    const [roundData, decimals] = await Promise.all([
      contract.latestRoundData(),
      contract.decimals(),
    ]);

    const answer = Number(roundData[1]);
    const scale = 10 ** Number(decimals);
    const value = answer / scale;
    if (!Number.isFinite(value) || value <= 0) return null;
    prices[symbol] = value;
  }

  return {
    source: "chainlink",
    prices: prices as Record<AppSymbol, number>,
    timestamp: Date.now(),
  };
}

async function fetchBinancePrices(): Promise<PricePayload | null> {
  const symbolsJson = JSON.stringify(SYMBOLS.map((symbol) => BINANCE_SYMBOLS[symbol]));
  const response = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(symbolsJson)}`,
    { cache: "no-store" }
  );

  if (!response.ok) return null;
  const rows = (await response.json()) as Array<{ symbol: string; price: string }>;
  const prices: Partial<Record<AppSymbol, number>> = {};

  for (const row of rows) {
    const symbol = SYMBOLS.find((candidate) => BINANCE_SYMBOLS[candidate] === row.symbol);
    if (!symbol) continue;
    const value = Number(row.price);
    if (Number.isFinite(value) && value > 0) {
      prices[symbol] = value;
    }
  }

  if (!SYMBOLS.every((symbol) => typeof prices[symbol] === "number")) return null;

  return {
    source: "binance",
    prices: prices as Record<AppSymbol, number>,
    timestamp: Date.now(),
  };
}

export async function GET() {
  const primary = await fetchChaosEdgePrices().catch(() => null);
  if (primary) {
    return new Response(JSON.stringify(primary), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const backup = await fetchChainlinkPrices().catch(() => null);
  if (backup) {
    return new Response(JSON.stringify(backup), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const tertiary = await fetchBinancePrices().catch(() => null);
  if (tertiary) {
    return new Response(JSON.stringify(tertiary), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "No live price source available" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}
