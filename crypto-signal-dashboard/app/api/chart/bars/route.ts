type CoinbaseCandle = [number, number, number, number, number, number];

const COINBASE_API = "https://api.exchange.coinbase.com";
const MAX_CANDLES = 300;
const PRODUCTS: Record<string, string> = {
  "COINBASE:BTCUSD": "BTC-USD",
  "COINBASE:ETHUSD": "ETH-USD",
  "COINBASE:SOLUSD": "SOL-USD",
};
const GRANULARITY_SECONDS: Record<string, number> = {
  "1": 60,
  "5": 300,
  "15": 900,
  "60": 3600,
  "360": 21600,
  "1D": 86400,
  D: 86400,
};

function finiteInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
  const resolution = String(url.searchParams.get("resolution") || "15").trim().toUpperCase();
  const product = PRODUCTS[symbol];
  const granularity = GRANULARITY_SECONDS[resolution];

  if (!product || !granularity) {
    return Response.json({ error: "Unsupported chart symbol or resolution" }, { status: 400 });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const requestedTo = finiteInteger(url.searchParams.get("to"), nowSeconds);
  const to = Math.min(nowSeconds, Math.max(1, requestedTo));
  const countback = Math.min(
    MAX_CANDLES,
    Math.max(10, finiteInteger(url.searchParams.get("countback"), MAX_CANDLES))
  );
  const requestedFrom = finiteInteger(
    url.searchParams.get("from"),
    to - countback * granularity
  );
  const from = Math.max(
    1,
    Math.min(requestedFrom, to - granularity),
    to - MAX_CANDLES * granularity
  );

  const query = new URLSearchParams({
    granularity: String(granularity),
    start: new Date(from * 1000).toISOString(),
    end: new Date(to * 1000).toISOString(),
  });

  try {
    const response = await fetch(`${COINBASE_API}/products/${product}/candles?${query}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return Response.json(
        { error: `Coinbase candle request failed with HTTP ${response.status}` },
        { status: 502 }
      );
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      return Response.json({ error: "Coinbase returned invalid candle data" }, { status: 502 });
    }

    const bars = payload
      .flatMap((entry) => {
        if (!Array.isArray(entry) || entry.length < 6) return [];
        const candle = entry as CoinbaseCandle;
        const time = Number(candle[0]) * 1000;
        const low = Number(candle[1]);
        const high = Number(candle[2]);
        const open = Number(candle[3]);
        const close = Number(candle[4]);
        const volume = Number(candle[5]);

        return [time, low, high, open, close, volume].every(Number.isFinite)
          ? [{ time, low, high, open, close, volume }]
          : [];
      })
      .sort((left, right) => left.time - right.time);

    return Response.json(
      { bars, noData: bars.length === 0 },
      {
        headers: {
          "Cache-Control": "public, max-age=5, stale-while-revalidate=15",
        },
      }
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Chart data unavailable" },
      { status: 502 }
    );
  }
}
