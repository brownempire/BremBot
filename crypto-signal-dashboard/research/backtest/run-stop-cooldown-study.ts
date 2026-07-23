import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type Asset,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const assets: Asset[] = ["SOL", "ETH", "BTC"];
const cooldownMinutes = [5, 15, 30, 45, 60, 120, 180, 240, 480, 720, 1_440];
const periods = [
  { name: "development", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
  { name: "forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
];

const control = structuredClone(frozen);
control.settings.perpsLeverage = 2;
control.settings.smartTradeProfile = "aggressive";
control.settings.mode = "all";
control.profile.leverageCap = 2;
control.profile.takeProfitRoePercent = 25;
control.profile.targetWalletRiskPercent = 0.75;

const rows: Array<{
  asset: Asset;
  period: string;
  cooldownMinutes: number;
  returnPercent: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  stopLossCount: number;
}> = [];
for (const asset of assets) {
  const candles = loadCandles(path.join(root, "data", "coinbase", `${asset.toLowerCase()}-usd-1m.csv`));
  process.stdout.write(`${asset}: preparing indicators\n`);
  const preparedIndicators = prepareIndicators(candles, getIndicatorSettings(frozen.profile), undefined, 60);
  for (const cooldown of cooldownMinutes) {
    const variant: StrategyVariant = {
      name: `tp25-sl15-stop-cooldown-${cooldown}m`,
      trendWindow: 10,
      trendThreshold: 0.15,
      breakoutPercent: 0.65,
      cooldownSeconds: 300,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
      directionMode: "all",
      indicatorLookbackMinutes: 60,
      stopLossRoePercent: 15,
      stopLossCooldownSeconds: cooldown * 60,
    };
    for (const period of periods) {
      const result = runBacktest({
        asset,
        candles,
        preparedIndicators,
        control,
        variant,
        costs: BASELINE_COST_MODEL,
        startMs: period.start,
        endMs: period.end,
        startingCapitalUsd: 1_000,
      });
      rows.push({
        asset,
        period: period.name,
        cooldownMinutes: cooldown,
        returnPercent: result.returnPercent,
        maxDrawdownPercent: result.maxDrawdownPercent,
        profitFactor: result.profitFactor,
        tradeCount: result.tradeCount,
        winCount: result.winCount,
        lossCount: result.lossCount,
        stopLossCount: result.trades.filter((trade) => trade.exitReason === "stop-loss").length,
      });
    }
    process.stdout.write(`${asset}: ${cooldown}m complete\n`);
  }
}

const summaries = cooldownMinutes.map((cooldown) => {
  const selected = rows.filter((row) => row.cooldownMinutes === cooldown);
  return {
    cooldownMinutes: cooldown,
    positiveSegments: selected.filter((row) => row.returnPercent > 0 && row.profitFactor > 1).length,
    averageReturnPercent: selected.reduce((sum, row) => sum + row.returnPercent, 0) / selected.length,
    worstDrawdownPercent: Math.max(...selected.map((row) => row.maxDrawdownPercent)),
    totalTrades: selected.reduce((sum, row) => sum + row.tradeCount, 0),
    totalStopLosses: selected.reduce((sum, row) => sum + row.stopLossCount, 0),
  };
});
const file = path.join(root, "results", "broad-search", "stop-cooldown-study.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "Research-only post-stop lockout sweep using 25% TP, 15% SL, 2x leverage, and the broad-search signal center across SOL/ETH/BTC development and forward periods.",
  cooldownMinutes,
  summaries,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
