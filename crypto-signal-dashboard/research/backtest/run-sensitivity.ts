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

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function numberArg(name: string, fallback: number) {
  const parsed = Number(arg(name, String(fallback)));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${name}`);
  return parsed;
}

function parseDate(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid date ${value}`);
  return parsed;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const control = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const asset = arg("asset", "SOL").toUpperCase() as Asset;
if (!["SOL", "ETH", "BTC"].includes(asset)) throw new Error(`Unsupported asset ${asset}`);
const dataDir = path.resolve(arg("data", path.join(root, "data", "coinbase")));
const outputDir = path.resolve(arg("out", path.join(root, "results", "sensitivity")));
const startMs = parseDate(arg("start", "2026-04-01T00:00:00Z"));
const endMs = parseDate(arg("end", "2026-07-20T00:00:00Z"));
const baseVariant: StrategyVariant = {
  name: arg("name", "selected"),
  trendWindow: numberArg("window", control.profile.trendWindow),
  trendThreshold: numberArg("trend", control.profile.assetAdjustments[asset].trendThreshold),
  breakoutPercent: numberArg("breakout", control.profile.assetAdjustments[asset].breakoutPercent),
  cooldownSeconds: numberArg("cooldown", control.profile.cooldownSeconds),
  useIndicators: arg("indicators", "true") !== "false",
  useLearnedConfirmation: arg("confirmation", "true") !== "false",
  useDecisionLayer: arg("decision", "true") !== "false",
};
const leverage = numberArg("leverage", control.settings.perpsLeverage);
control.settings.perpsLeverage = leverage;
control.profile.leverageCap = leverage;
control.profile.takeProfitRoePercent = numberArg("take-profit-roe", control.profile.takeProfitRoePercent);
control.profile.targetWalletRiskPercent = numberArg("risk-target", control.profile.targetWalletRiskPercent);

const costs: CostModel[] = [
  {
    ...BASELINE_COST_MODEL,
    name: "base-fees-only-optimistic",
    priceImpactFeeRate: 0,
    networkCostUsd: 0,
    borrowRateMultiplier: 0,
  },
  BASELINE_COST_MODEL,
  {
    ...BASELINE_COST_MODEL,
    name: "conservative-costs",
    priceImpactFeeRate: 0.0002,
    slippageBps: 3,
    networkCostUsd: 0.05,
    borrowRateMultiplier: 2,
  },
  {
    ...BASELINE_COST_MODEL,
    name: "stress-costs",
    priceImpactFeeRate: 0.0005,
    slippageBps: 10,
    networkCostUsd: 0.1,
    borrowRateMultiplier: 3,
  },
];

fs.mkdirSync(outputDir, { recursive: true });
const candles = loadCandles(path.join(dataDir, `${asset.toLowerCase()}-usd-1m.csv`));
const prepared = prepareIndicators(candles, getIndicatorSettings(control.profile), (percent) => {
  process.stdout.write(`${asset}: indicators ${percent}%\n`);
});
const rows = [];
for (const executionTiming of ["next-open", "signal-close"] as const) {
  for (const costModel of costs) {
    const variant = { ...baseVariant, executionTiming, name: `${baseVariant.name}-${executionTiming}` };
    const result = runBacktest({
      asset,
      candles,
      preparedIndicators: prepared,
      control,
      variant,
      costs: costModel,
      startMs,
      endMs,
    });
    const { trades, ...summary } = result;
    rows.push({ executionTiming, costModel, summary, trades });
    process.stdout.write(
      `${executionTiming} ${costModel.name}: ${result.tradeCount} trades, `
      + `${result.returnPercent}% return, ${result.maxDrawdownPercent}% max DD, PF ${result.profitFactor}\n`
    );
  }
}
const output = {
  generatedAt: new Date().toISOString(),
  commit: control.commit,
  asset,
  period: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  variant: baseVariant,
  riskConfiguration: {
    leverage: control.settings.perpsLeverage,
    takeProfitRoePercent: control.profile.takeProfitRoePercent,
    targetWalletRiskPercent: control.profile.targetWalletRiskPercent,
  },
  rows,
};
const file = path.join(outputDir, `${asset.toLowerCase()}-${baseVariant.name}.json`);
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
