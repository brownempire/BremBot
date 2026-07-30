type ChartBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type PeriodParams = {
  from: number;
  to: number;
  countBack: number;
};

type SymbolInfo = {
  name: string;
  ticker: string;
  description: string;
  type: string;
  session: string;
  exchange: string;
  listed_exchange: string;
  timezone: string;
  format: string;
  pricescale: number;
  minmov: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: string[];
  intraday_multipliers: string[];
  daily_multipliers: string[];
  volume_precision: number;
  data_status: string;
};

type MarketDefinition = {
  symbol: string;
  product: string;
  shortName: string;
  description: string;
  priceScale: number;
};

type RealtimeSubscription = {
  timer: ReturnType<typeof setInterval>;
};

const SUPPORTED_RESOLUTIONS = ["1", "5", "15", "60", "360", "1D"];
const MARKETS: MarketDefinition[] = [
  {
    symbol: "COINBASE:BTCUSD",
    product: "BTC-USD",
    shortName: "BTCUSD",
    description: "Bitcoin / U.S. Dollar",
    priceScale: 100,
  },
  {
    symbol: "COINBASE:ETHUSD",
    product: "ETH-USD",
    shortName: "ETHUSD",
    description: "Ethereum / U.S. Dollar",
    priceScale: 100,
  },
  {
    symbol: "COINBASE:SOLUSD",
    product: "SOL-USD",
    shortName: "SOLUSD",
    description: "Solana / U.S. Dollar",
    priceScale: 1000,
  },
];

const lastBars = new Map<string, ChartBar>();
const subscriptions = new Map<string, RealtimeSubscription>();

function marketForSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  return MARKETS.find(
    (market) => market.symbol === normalized || market.shortName === normalized
  );
}

function intervalSeconds(resolution: string) {
  const normalized = resolution.trim().toUpperCase();
  if (normalized === "1D" || normalized === "D") return 86_400;
  const minutes = Number(normalized);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 900;
}

function barKey(symbol: string, resolution: string) {
  return `${symbol.toUpperCase()}::${resolution.toUpperCase()}`;
}

function symbolInfo(market: MarketDefinition): SymbolInfo {
  return {
    name: market.shortName,
    ticker: market.symbol,
    description: market.description,
    type: "crypto",
    session: "24x7",
    exchange: "Coinbase",
    listed_exchange: "Coinbase",
    timezone: "Etc/UTC",
    format: "price",
    pricescale: market.priceScale,
    minmov: 1,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    intraday_multipliers: ["1", "5", "15", "60", "360"],
    daily_multipliers: ["1"],
    volume_precision: 8,
    data_status: "streaming",
  };
}

async function fetchLivePrice(product: string) {
  const response = await fetch(
    `/api/prices/live?products=${encodeURIComponent(product)}`,
    { cache: "no-store" }
  );
  const payload = await response.json();
  const price = Number(payload?.markets?.[product]?.price);
  const timestamp = Number(payload?.timestamp) || Date.now();
  if (!response.ok || !Number.isFinite(price) || price <= 0) {
    throw new Error("Live chart price unavailable");
  }
  return { price, timestamp };
}

export function createBremLogicDatafeed() {
  return {
    onReady(callback: (configuration: Record<string, unknown>) => void) {
      queueMicrotask(() =>
        callback({
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          exchanges: [{ value: "Coinbase", name: "Coinbase", desc: "Coinbase" }],
          symbols_types: [{ name: "Crypto", value: "crypto" }],
          supports_marks: false,
          supports_timescale_marks: false,
          supports_time: true,
        })
      );
    },

    searchSymbols(
      userInput: string,
      exchange: string,
      _symbolType: string,
      onResult: (items: Record<string, unknown>[]) => void
    ) {
      const query = userInput.trim().toUpperCase();
      const items = MARKETS.filter((market) => {
        const matchesExchange = !exchange || exchange.toLowerCase() === "coinbase";
        return (
          matchesExchange &&
          (!query ||
            market.symbol.includes(query) ||
            market.shortName.includes(query) ||
            market.description.toUpperCase().includes(query))
        );
      }).map((market) => ({
        symbol: market.shortName,
        full_name: market.symbol,
        description: market.description,
        exchange: "Coinbase",
        ticker: market.symbol,
        type: "crypto",
      }));
      queueMicrotask(() => onResult(items));
    },

    resolveSymbol(
      symbolName: string,
      onResolve: (info: SymbolInfo) => void,
      onError: (reason: string) => void
    ) {
      const market = marketForSymbol(symbolName);
      queueMicrotask(() => {
        if (!market) {
          onError(`Unsupported BremLogic market: ${symbolName}`);
          return;
        }
        onResolve(symbolInfo(market));
      });
    },

    async getBars(
      info: SymbolInfo,
      resolution: string,
      period: PeriodParams,
      onResult: (bars: ChartBar[], metadata: { noData: boolean }) => void,
      onError: (reason: string) => void
    ) {
      try {
        const query = new URLSearchParams({
          symbol: info.ticker,
          resolution,
          from: String(period.from),
          to: String(period.to),
          countback: String(period.countBack),
        });
        const response = await fetch(`/api/chart/bars?${query}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload?.bars)) {
          throw new Error(String(payload?.error || "Historical chart data unavailable"));
        }
        const bars = payload.bars as ChartBar[];
        const latest = bars[bars.length - 1];
        if (latest) lastBars.set(barKey(info.ticker, resolution), latest);
        onResult(bars, { noData: Boolean(payload.noData) });
      } catch (error) {
        onError(error instanceof Error ? error.message : "Historical chart data unavailable");
      }
    },

    subscribeBars(
      info: SymbolInfo,
      resolution: string,
      onTick: (bar: ChartBar) => void,
      listenerGuid: string
    ) {
      const market = marketForSymbol(info.ticker);
      if (!market) return;

      const update = async () => {
        try {
          const { price, timestamp } = await fetchLivePrice(market.product);
          const durationMs = intervalSeconds(resolution) * 1000;
          const time = Math.floor(timestamp / durationMs) * durationMs;
          const key = barKey(info.ticker, resolution);
          const previous = lastBars.get(key);
          const bar =
            previous && previous.time === time
              ? {
                  ...previous,
                  high: Math.max(previous.high, price),
                  low: Math.min(previous.low, price),
                  close: price,
                }
              : {
                  time,
                  open: price,
                  high: price,
                  low: price,
                  close: price,
                  volume: 0,
                };
          lastBars.set(key, bar);
          onTick(bar);
        } catch {
          // Preserve the last valid bar through short network interruptions.
        }
      };

      void update();
      const timer = setInterval(update, 5_000);
      subscriptions.set(listenerGuid, { timer });
    },

    unsubscribeBars(listenerGuid: string) {
      const subscription = subscriptions.get(listenerGuid);
      if (!subscription) return;
      clearInterval(subscription.timer);
      subscriptions.delete(listenerGuid);
    },

    getServerTime(callback: (unixTime: number) => void) {
      callback(Math.floor(Date.now() / 1000));
    },
  };
}
