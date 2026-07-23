import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type Asset,
  type CostModel,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

type Candidate = {
  name: string;
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  leverage: number;
  takeProfitRoePercent: number;
  targetWalletRiskPercent: number;
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const assets: Asset[] = ["SOL", "ETH", "BTC"];
const stopLossRoes: Array<number | undefined> = [undefined, 8, 10, 12, 15, 18, 20, 25, 30];
const candidates: Candidate[] = [
  {
    name: "broad-search-center",
    trendWindow: 10,
    trendThreshold: 0.15,
    breakoutPercent: 0.65,
    cooldownSeconds: 300,
    leverage: 2,
    takeProfitRoePercent: 15,
    targetWalletRiskPercent: 0.75,
  },
  {
    name: "broad-search-center-tp25",
    trendWindow: 10,
    trendThreshold: 0.15,
    breakoutPercent: 0.65,
    cooldownSeconds: 300,
    leverage: 2,
    takeProfitRoePercent: 25,
    targetWalletRiskPercent: 0.75,
  },
  {
    name: "local-plateau-leader",
    trendWindow: 15,
    trendThreshold: 0.125,
    breakoutPercent: 0.45,
    cooldownSeconds: 360,
    leverage: 1.5,
    takeProfitRoePercent: 20,
    targetWalletRiskPercent: 0.5,
  },
];
const periods = [
  { name: "development", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
  { name: "forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
  { name: "full", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
];
const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};

const assetData = new Map<Asset, {
  candles: ReturnType<typeof loadCandles>;
  prepared: ReturnType<typeof prepareIndicators>;
}>();
for (const asset of assets) {
  const candles = loadCandles(path.join(root, "data", "coinbase", `${asset.toLowerCase()}-usd-1m.csv`));
  process.stdout.write(`${asset}: preparing indicators\n`);
  assetData.set(asset, {
    candles,
    prepared: prepareIndicators(candles, getIndicatorSettings(frozen.profile), undefined, 60),
  });
}

const rows = [];
for (const candidate of candidates) {
  const control = structuredClone(frozen);
  control.settings.perpsLeverage = candidate.leverage;
  control.settings.smartTradeProfile = "aggressive";
  control.settings.mode = "all";
  control.profile.leverageCap = candidate.leverage;
  control.profile.takeProfitRoePercent = candidate.takeProfitRoePercent;
  control.profile.targetWalletRiskPercent = candidate.targetWalletRiskPercent;

  for (const stopLossRoePercent of stopLossRoes) {
    const variant: StrategyVariant = {
      name: `${candidate.name}-sl-${stopLossRoePercent ?? "none"}`,
      trendWindow: candidate.trendWindow,
      trendThreshold: candidate.trendThreshold,
      breakoutPercent: candidate.breakoutPercent,
      cooldownSeconds: candidate.cooldownSeconds,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
      directionMode: "all",
      indicatorLookbackMinutes: 60,
      stopLossRoePercent,
    };

    for (const asset of assets) {
      const data = assetData.get(asset)!;
      for (const period of periods) {
        const result = runBacktest({
          asset,
          candles: data.candles,
          preparedIndicators: data.prepared,
          control,
          variant,
          costs: BASELINE_COST_MODEL,
          startMs: period.start,
          endMs: period.end,
          startingCapitalUsd: 1_000,
        });
        const exitReasons = Object.fromEntries(result.trades.reduce((counts, trade) => {
          counts.set(trade.exitReason, (counts.get(trade.exitReason) ?? 0) + 1);
          return counts;
        }, new Map<string, number>()));
        const losses = result.trades.filter((trade) => trade.netPnlUsd < 0);
        rows.push({
          candidate: candidate.name,
          stopLossRoePercent: stopLossRoePercent ?? null,
          asset,
          period: period.name,
          costModel: BASELINE_COST_MODEL.name,
          summary: {
            returnPercent: result.returnPercent,
            maxDrawdownPercent: result.maxDrawdownPercent,
            profitFactor: result.profitFactor,
            tradeCount: result.tradeCount,
            winCount: result.winCount,
            lossCount: result.lossCount,
            averageLossUsd: losses.length === 0 ? 0 : losses.reduce((sum, trade) => sum + trade.netPnlUsd, 0) / losses.length,
            exitReasons,
          },
        });
      }
      const forwardStress = runBacktest({
        asset,
        candles: data.candles,
        preparedIndicators: data.prepared,
        control,
        variant,
        costs: stress,
        startMs: periods[1]!.start,
        endMs: periods[1]!.end,
        startingCapitalUsd: 1_000,
      });
      rows.push({
        candidate: candidate.name,
        stopLossRoePercent: stopLossRoePercent ?? null,
        asset,
        period: "forward",
        costModel: stress.name,
        summary: {
          returnPercent: forwardStress.returnPercent,
          maxDrawdownPercent: forwardStress.maxDrawdownPercent,
          profitFactor: forwardStress.profitFactor,
          tradeCount: forwardStress.tradeCount,
          winCount: forwardStress.winCount,
          lossCount: forwardStress.lossCount,
          averageLossUsd: 0,
          exitReasons: {},
        },
      });
    }
    process.stdout.write(`${candidate.name}: SL ${stopLossRoePercent ?? "none"} complete\n`);
  }
}

const file = path.join(root, "results", "broad-search", "stop-loss-study.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "Exact stop-loss sweep around 15% ROE on the broad-search center and local plateau leader; SOL/ETH/BTC; development, forward, full-history, and forward cost stress.",
  stopLossRoes,
  candidates,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
