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

function summarize(result: BacktestResult) {
  const { trades: _trades, dailyEquity: _dailyEquity, ...summary } = result;
  return {
    ...summary,
    stopLossCount: result.trades.filter((trade) => trade.exitReason === "stop-loss").length,
    takeProfitCount: result.trades.filter((trade) => trade.exitReason === "take-profit").length,
  };
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const control = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const candles = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const preparedIndicators = prepareIndicators(candles, getIndicatorSettings(control.profile), (percent) => {
  if (percent % 10 === 0) process.stdout.write(`SOL indicators ${percent}%\n`);
});

const stopLossRoePercents = [0, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50];
const periods = [
  { name: "2025-early", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2025-05-01T00:00:00Z") },
  { name: "2025-mid", start: Date.parse("2025-05-01T00:00:00Z"), end: Date.parse("2025-09-01T00:00:00Z") },
  { name: "2025-late", start: Date.parse("2025-09-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z") },
  { name: "2026-validation", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
  { name: "2026-forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
];
const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};

const rows = [];
for (const stopLossRoePercent of stopLossRoePercents) {
  const variant: StrategyVariant = {
    name: `current-smart-trades-sl-${stopLossRoePercent}`,
    trendWindow: control.profile.trendWindow,
    trendThreshold: control.profile.assetAdjustments.SOL.trendThreshold,
    breakoutPercent: control.profile.assetAdjustments.SOL.breakoutPercent,
    cooldownSeconds: control.profile.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    stopLossRoePercent: stopLossRoePercent || undefined,
    stopLossCooldownSeconds: control.profile.cooldownSeconds,
  };
  for (const period of periods) {
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
    rows.push({ stopLossRoePercent, segment: period.name, ...summarize(result) });
  }
  const forward = periods[periods.length - 1]!;
  const stressed = runBacktest({
    asset: "SOL",
    candles,
    preparedIndicators,
    control,
    variant,
    costs: stress,
    startMs: forward.start,
    endMs: forward.end,
    startingCapitalUsd: 1_000,
  });
  rows.push({ stopLossRoePercent, segment: "2026-forward", ...summarize(stressed) });
  const selected = rows.filter((row) => row.stopLossRoePercent === stopLossRoePercent);
  process.stdout.write(
    `SL ${stopLossRoePercent}%: ${selected.map((row) => `${row.costModel === "stress-costs" ? "stress" : row.segment} ${row.returnPercent.toFixed(1)}%`).join(" | ")}\n`
  );
}

const rankings = stopLossRoePercents.map((stopLossRoePercent) => {
  const baseline = rows.filter((row) => row.stopLossRoePercent === stopLossRoePercent && row.costModel === BASELINE_COST_MODEL.name);
  const forwardStress = rows.find((row) => row.stopLossRoePercent === stopLossRoePercent && row.costModel === stress.name)!;
  const development = baseline.slice(0, 4);
  return {
    stopLossRoePercent,
    profitableDevelopmentFolds: development.filter((row) => row.returnPercent > 0 && row.profitFactor > 1).length,
    averageDevelopmentReturnPercent: development.reduce((sum, row) => sum + row.returnPercent, 0) / development.length,
    worstDevelopmentReturnPercent: Math.min(...development.map((row) => row.returnPercent)),
    worstDevelopmentDrawdownPercent: Math.max(...development.map((row) => row.maxDrawdownPercent)),
    forwardReturnPercent: baseline[4]!.returnPercent,
    forwardDrawdownPercent: baseline[4]!.maxDrawdownPercent,
    forwardStressReturnPercent: forwardStress.returnPercent,
    forwardStressDrawdownPercent: forwardStress.maxDrawdownPercent,
    totalDevelopmentTrades: development.reduce((sum, row) => sum + row.tradeCount, 0),
    totalDevelopmentStops: development.reduce((sum, row) => sum + row.stopLossCount, 0),
    totalDevelopmentLiquidations: development.reduce((sum, row) => sum + row.liquidationCount, 0),
  };
}).sort((left, right) => {
  if (left.profitableDevelopmentFolds !== right.profitableDevelopmentFolds) return right.profitableDevelopmentFolds - left.profitableDevelopmentFolds;
  if ((left.forwardStressReturnPercent > 0) !== (right.forwardStressReturnPercent > 0)) return Number(right.forwardStressReturnPercent > 0) - Number(left.forwardStressReturnPercent > 0);
  if (left.worstDevelopmentDrawdownPercent !== right.worstDevelopmentDrawdownPercent) return left.worstDevelopmentDrawdownPercent - right.worstDevelopmentDrawdownPercent;
  return right.averageDevelopmentReturnPercent - left.averageDevelopmentReturnPercent;
});

const output = path.join(root, "results", "broad-search", "sol-current-stop-loss-study.json");
fs.writeFileSync(output, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "Fixed SL ROE sweep applied to the otherwise unchanged current primary-wallet SOL Smart Trades engine on one-minute candles. Each stop uses the existing 180-second post-stop lockout. Four development folds and forward baseline/stress match the SOL-specialized comparison periods.",
  stopLossRoePercents,
  currentEffectiveControls: {
    trendWindow: control.profile.trendWindow,
    trendThreshold: control.profile.assetAdjustments.SOL.trendThreshold,
    breakoutPercent: control.profile.assetAdjustments.SOL.breakoutPercent,
    cooldownSeconds: control.profile.cooldownSeconds,
    leverageCap: control.profile.leverageCap,
    leverageMultiplier: control.profile.assetAdjustments.SOL.leverageMultiplier,
    takeProfitRoePercent: control.profile.takeProfitRoePercent,
  },
  rankings,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${output}\n`);
process.stdout.write(`${JSON.stringify(rankings, null, 2)}\n`);
