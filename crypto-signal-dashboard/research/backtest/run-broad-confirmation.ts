import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type CostModel,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

type Candidate = {
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  leverage: number;
  takeProfitRoePercent: number;
  targetWalletRiskPercent: number;
  smartTradeProfile: "conservative" | "balanced" | "aggressive";
  directionMode: "all" | "buy-only";
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const searchFile = path.join(root, "results", "broad-search", "sol-development.json");
const search = JSON.parse(fs.readFileSync(searchFile, "utf8")) as {
  rows: Array<{ candidate: Candidate; profitableFoldCount: number }>;
};
const candidates = search.rows.filter((row) => row.profitableFoldCount === 4).slice(0, 12).map((row) => row.candidate);
if (candidates.length === 0) throw new Error("No four-fold development survivors were found.");
const candles = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const preparedCache = new Map<number, ReturnType<typeof prepareIndicators>>();
function preparedFor(candidate: Candidate) {
  const lookback = Math.min(240, Math.max(60, candidate.trendWindow + 35));
  const existing = preparedCache.get(lookback);
  if (existing) return existing;
  process.stdout.write(`SOL: preparing ${lookback}m indicators\n`);
  const prepared = prepareIndicators(candles, getIndicatorSettings(frozen.profile), undefined, lookback);
  preparedCache.set(lookback, prepared);
  return prepared;
}

const conservative: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "conservative-costs",
  priceImpactFeeRate: 0.0002,
  slippageBps: 3,
  networkCostUsd: 0.05,
  borrowRateMultiplier: 2,
};
const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};

const periods = [
  { name: "development-contiguous", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
  { name: "forward-confirmation", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
  { name: "full-history", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
];
const rows = [];
for (let index = 0; index < candidates.length; index += 1) {
  const candidate = candidates[index]!;
  const control = structuredClone(frozen);
  control.settings.perpsLeverage = candidate.leverage;
  control.settings.smartTradeProfile = candidate.smartTradeProfile;
  control.settings.mode = candidate.directionMode;
  control.profile.leverageCap = candidate.leverage;
  control.profile.takeProfitRoePercent = candidate.takeProfitRoePercent;
  control.profile.targetWalletRiskPercent = candidate.targetWalletRiskPercent;
  const variant: StrategyVariant = {
    name: `broad-survivor-${index + 1}`,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: candidate.directionMode,
    indicatorLookbackMinutes: Math.min(240, Math.max(60, candidate.trendWindow + 35)),
  };
  const prepared = preparedFor(candidate);
  const baselines = periods.flatMap((period) => [115.480621, 1_000].map((startingCapitalUsd) => ({
    period: period.name,
    startingCapitalUsd,
    result: runBacktest({
      asset: "SOL",
      candles,
      preparedIndicators: prepared,
      control,
      variant,
      costs: BASELINE_COST_MODEL,
      startMs: period.start,
      endMs: period.end,
      startingCapitalUsd,
    }),
  })));
  const forwardSensitivities = ([
    { costs: BASELINE_COST_MODEL, timing: "next-open" as const },
    { costs: conservative, timing: "next-open" as const },
    { costs: stress, timing: "next-open" as const },
    { costs: BASELINE_COST_MODEL, timing: "signal-close" as const },
  ]).map(({ costs, timing }) => ({
    costModel: costs.name,
    timing,
    result: runBacktest({
      asset: "SOL",
      candles,
      preparedIndicators: prepared,
      control,
      variant: { ...variant, executionTiming: timing },
      costs,
      startMs: Date.parse("2026-04-01T00:00:00Z"),
      endMs: Date.parse("2026-07-20T00:00:00Z"),
      startingCapitalUsd: 1_000,
    }),
  }));
  rows.push({ candidate, variant, baselines, forwardSensitivities });
  const forward = baselines.find((item) => item.period === "forward-confirmation" && item.startingCapitalUsd === 1_000)!.result;
  process.stdout.write(`survivor ${index + 1}/${candidates.length}: forward ${forward.returnPercent}% PF ${forward.profitFactor} DD ${forward.maxDrawdownPercent}% trades ${forward.tradeCount}\n`);
}

const outputDir = path.join(root, "results", "broad-search");
const file = path.join(outputDir, "sol-confirmation.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: searchFile,
  caveat: "The forward period was used by the earlier narrow study and is confirmation, not a pristine holdout for this expanded search.",
  survivorCount: candidates.length,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
