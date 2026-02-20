import { clamp } from "../utils";

export type PricePoint = {
  t: number;
  v: number;
};

export type PriceSeries = {
  symbol: string;
  points: PricePoint[];
};

type SimConfig = {
  base: number;
  volatility: number;
};

const DEFAULT_SERIES: Record<string, SimConfig> = {
  "BTC/USD": { base: 64850, volatility: 0.004 },
  "ETH/USD": { base: 3425, volatility: 0.006 },
  "SOL/USD": { base: 98, volatility: 0.012 },
};

export function createSimulatedFeed(symbols: string[]) {
  const state = new Map<string, number>();

  symbols.forEach((symbol) => {
    const config = DEFAULT_SERIES[symbol] ?? { base: 100, volatility: 0.01 };
    state.set(symbol, config.base);
  });

  return function next(): PriceSeries[] {
    const now = Date.now();
    return symbols.map((symbol) => {
      const config = DEFAULT_SERIES[symbol] ?? { base: 100, volatility: 0.01 };
      const current = state.get(symbol) ?? config.base;
      const shock = (Math.random() - 0.45) * config.volatility;
      const momentum = Math.sin(now / 120000 + current) * config.volatility * 0.6;
      const nextValue = clamp(current * (1 + shock + momentum), config.base * 0.6, config.base * 1.6);
      state.set(symbol, nextValue);
      return {
        symbol,
        points: [{ t: now, v: nextValue }],
      };
    });
  };
}
