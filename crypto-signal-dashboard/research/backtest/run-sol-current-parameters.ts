import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type BacktestResult,
  type CostModel,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

function summary(result: BacktestResult) {
  const { trades: _trades, dailyEquity: _dailyEquity, ...rest } = result;
  return rest;
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const control = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const candles = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const preparedIndicators = prepareIndicators(candles, getIndicatorSettings(control.profile), (percent) => {
  if (percent % 10 === 0) process.stdout.write(`SOL indicators ${percent}%\n`);
});

// These values were verified against the primary wallet's Redis configuration on
// 2026-07-20. The learned SOL thresholds are retained because Smart Trades applies
// the active profile after loading the saved operator controls.
const variant: StrategyVariant = {
  name: "current-primary-wallet-smart-trades",
  trendWindow: control.profile.trendWindow,
  trendThreshold: control.profile.assetAdjustments.SOL.trendThreshold,
  breakoutPercent: control.profile.assetAdjustments.SOL.breakoutPercent,
  cooldownSeconds: control.profile.cooldownSeconds,
  useIndicators: true,
  useLearnedConfirmation: true,
  useDecisionLayer: true,
};

const folds = [
  { name: "2025-early", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2025-05-01T00:00:00Z") },
  { name: "2025-mid", start: Date.parse("2025-05-01T00:00:00Z"), end: Date.parse("2025-09-01T00:00:00Z") },
  { name: "2025-late", start: Date.parse("2025-09-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z") },
  { name: "2026-validation", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
];
const forward = { name: "2026-forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") };
const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};

const rows = [];
for (const period of folds) {
  const result = runBacktest({
    asset: "SOL",
    candles,
    preparedIndicators,
    control,
    variant,
    costs: BASELINE_COST_MODEL,
    startMs: period.start,
    endMs: period.end,
    startingCapitalUsd: 1_000,
  });
  rows.push({ segment: period.name, ...summary(result) });
  process.stdout.write(`${period.name}: ${result.returnPercent.toFixed(2)}%, DD ${result.maxDrawdownPercent.toFixed(2)}%, ${result.tradeCount} trades\n`);
}

for (const costs of [BASELINE_COST_MODEL, stress]) {
  const result = runBacktest({
    asset: "SOL",
    candles,
    preparedIndicators,
    control,
    variant,
    costs,
    startMs: forward.start,
    endMs: forward.end,
    startingCapitalUsd: 1_000,
  });
  rows.push({ segment: forward.name, ...summary(result) });
  process.stdout.write(`${forward.name} ${costs.name}: ${result.returnPercent.toFixed(2)}%, DD ${result.maxDrawdownPercent.toFixed(2)}%, ${result.tradeCount} trades\n`);
}

const output = path.join(root, "results", "broad-search", "sol-current-parameters.json");
fs.writeFileSync(output, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "Current primary-wallet SOL Smart Trades configuration replayed on one-minute candles across the same four development folds and forward baseline/stress periods used by the SOL-specialized study.",
  savedOperatorControls: control.params,
  activeLearnedSolControls: {
    trendWindow: variant.trendWindow,
    trendThreshold: variant.trendThreshold,
    breakoutPercent: variant.breakoutPercent,
    cooldownSeconds: variant.cooldownSeconds,
    leverageCap: control.profile.leverageCap,
    takeProfitRoePercent: control.profile.takeProfitRoePercent,
    stopLossRoePercent: control.profile.stopLossRoePercent,
  },
  executionSettings: control.settings,
  caveat: "Smart Trades dynamically derives leverage and TP/SL from signal confidence, volatility, and the frozen active learning profile; the configured 50x value is a cap, not a constant fill leverage.",
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${output}\n`);
