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

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function values(name: string, fallback: string) {
  return arg(name, fallback).split(",").map(Number).filter(Number.isFinite);
}

function date(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date ${value}`);
  return parsed;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const asset = arg("asset", "SOL").toUpperCase() as Asset;
if (!["SOL", "ETH", "BTC"].includes(asset)) throw new Error(`Unsupported asset ${asset}`);
const dataDir = path.resolve(arg("data", path.join(root, "data", "coinbase")));
const outputDir = path.resolve(arg("out", path.join(root, "results", "risk-grid")));
const variant: StrategyVariant = {
  name: arg("name", "selected-signal-parameters"),
  trendWindow: Number(arg("window", String(frozen.profile.trendWindow))),
  trendThreshold: Number(arg("trend", String(frozen.profile.assetAdjustments[asset].trendThreshold))),
  breakoutPercent: Number(arg("breakout", String(frozen.profile.assetAdjustments[asset].breakoutPercent))),
  cooldownSeconds: Number(arg("cooldown", String(frozen.profile.cooldownSeconds))),
  useIndicators: true,
  useLearnedConfirmation: true,
  useDecisionLayer: true,
};
const leverages = values("leverages", "5,8,10,20,30,50");
const takeProfitRoeValues = values("take-profits", "10,15,20,25,30,40");
const riskTargets = values("risk-targets", "0.5,1,1.6,2");
const periods = [
  { name: "training", start: date("2025-01-01T00:00:00Z"), end: date("2025-11-01T00:00:00Z") },
  { name: "validation", start: date("2025-11-01T00:00:00Z"), end: date("2026-04-01T00:00:00Z") },
];

fs.mkdirSync(outputDir, { recursive: true });
const candles = loadCandles(path.join(dataDir, `${asset.toLowerCase()}-usd-1m.csv`));
const prepared = prepareIndicators(candles, getIndicatorSettings(frozen.profile), (percent) => {
  process.stdout.write(`${asset}: indicators ${percent}%\n`);
});
const rows = [];
const total = leverages.length * takeProfitRoeValues.length * riskTargets.length;
let complete = 0;
for (const leverage of leverages) {
  for (const takeProfitRoePercent of takeProfitRoeValues) {
    for (const targetWalletRiskPercent of riskTargets) {
      const control = structuredClone(frozen);
      control.settings.perpsLeverage = leverage;
      control.profile.leverageCap = leverage;
      control.profile.takeProfitRoePercent = takeProfitRoePercent;
      control.profile.targetWalletRiskPercent = targetWalletRiskPercent;
      const results = periods.map((period) => runBacktest({
        asset,
        candles,
        preparedIndicators: prepared,
        control,
        variant,
        costs: BASELINE_COST_MODEL,
        startMs: period.start,
        endMs: period.end,
      }));
      rows.push({
        leverage,
        takeProfitRoePercent,
        targetWalletRiskPercent,
        results: results.map((result, index) => {
          const { trades: _trades, dailyEquity: _dailyEquity, ...summary } = result;
          return { segment: periods[index]!.name, ...summary };
        }),
      });
      complete += 1;
      if (complete % 10 === 0 || complete === total) process.stdout.write(`${asset}: risk grid ${complete}/${total}\n`);
    }
  }
}

const file = path.join(outputDir, `${asset.toLowerCase()}-${variant.name}.json`);
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  commit: frozen.commit,
  selectionBoundary: "No candles on or after 2026-04-01 are used.",
  asset,
  variant,
  dimensions: { leverages, takeProfitRoeValues, riskTargets },
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
