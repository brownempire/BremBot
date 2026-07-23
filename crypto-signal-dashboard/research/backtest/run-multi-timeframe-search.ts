import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  getIndicatorSettings,
  loadCandles,
  prepareIndicators,
  runBacktest,
  type BacktestResult,
  type Asset,
  type Candle,
  type CostModel,
  type FrozenControl,
  type StrategyVariant,
} from "./model";

type Candidate = {
  trendWindow: number;
  trendThreshold: number;
  breakoutPercent: number;
  cooldownSeconds: number;
  emaFast: number;
  emaSlow: number;
  useFourHourRegime: boolean;
};

function halton(index: number, base: number) {
  let result = 0;
  let fraction = 1 / base;
  let value = index;
  while (value > 0) {
    result += fraction * (value % base);
    value = Math.floor(value / base);
    fraction /= base;
  }
  return result;
}

function choose<T>(values: readonly T[], fraction: number) {
  return values[Math.min(values.length - 1, Math.floor(fraction * values.length))]!;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function quality(result: BacktestResult) {
  if (result.tradeCount < 5) return -250;
  return result.returnPercent
    - 1.2 * result.maxDrawdownPercent
    + 10 * Math.log1p(Math.min(4, result.profitFactor))
    + 2 * result.sharpeRatio;
}

function compact(result: BacktestResult) {
  const { trades: _trades, dailyEquity: _dailyEquity, variant: _variant, ...summary } = result;
  return summary;
}

function resample(candles: Candle[], minutes: number) {
  const intervalMs = minutes * 60_000;
  const output: Candle[] = [];
  let bucket = -1;
  let current: Candle | null = null;
  for (const candle of candles) {
    const nextBucket = Math.floor(candle.t / intervalMs) * intervalMs;
    if (nextBucket !== bucket) {
      if (current) output.push(current);
      bucket = nextBucket;
      current = {
        t: nextBucket + intervalMs - 60_000,
        o: candle.o,
        h: candle.h,
        l: candle.l,
        v: candle.v,
        volume: candle.volume,
      };
    } else {
      current!.h = Math.max(current!.h, candle.h);
      current!.l = Math.min(current!.l, candle.l);
      current!.v = candle.v;
      current!.volume += candle.volume;
    }
  }
  if (current) output.push(current);
  return output;
}

function emaAlignment(candles: Candle[], fastPeriod: number, slowPeriod: number) {
  const bull = new Uint8Array(candles.length);
  const bear = new Uint8Array(candles.length);
  const fastMultiplier = 2 / (fastPeriod + 1);
  const slowMultiplier = 2 / (slowPeriod + 1);
  let fast: number | null = null;
  let slow: number | null = null;
  for (let index = 0; index < candles.length; index += 1) {
    if (index === fastPeriod - 1) fast = candles.slice(0, fastPeriod).reduce((sum, candle) => sum + candle.v, 0) / fastPeriod;
    else if (fast !== null && index >= fastPeriod) fast = (candles[index]!.v - fast) * fastMultiplier + fast;
    if (index === slowPeriod - 1) slow = candles.slice(0, slowPeriod).reduce((sum, candle) => sum + candle.v, 0) / slowPeriod;
    else if (slow !== null && index >= slowPeriod) slow = (candles[index]!.v - slow) * slowMultiplier + slow;
    if (fast !== null && slow !== null) {
      bull[index] = fast > slow ? 1 : 0;
      bear[index] = fast < slow ? 1 : 0;
    }
  }
  return { bull, bear };
}

function project(target: Candle[], source: Candle[], alignment: ReturnType<typeof emaAlignment>) {
  const bull = new Uint8Array(target.length);
  const bear = new Uint8Array(target.length);
  let sourceIndex = -1;
  for (let index = 0; index < target.length; index += 1) {
    while (sourceIndex + 1 < source.length && source[sourceIndex + 1]!.t <= target[index]!.t) sourceIndex += 1;
    if (sourceIndex >= 0) {
      bull[index] = alignment.bull[sourceIndex]!;
      bear[index] = alignment.bear[sourceIndex]!;
    }
  }
  return { bull, bear };
}

function combine(left: ReturnType<typeof project>, right: ReturnType<typeof project>) {
  const bullQualified = new Uint8Array(left.bull.length);
  const bearQualified = new Uint8Array(left.bear.length);
  for (let index = 0; index < bullQualified.length; index += 1) {
    bullQualified[index] = left.bull[index] && right.bull[index] ? 1 : 0;
    bearQualified[index] = left.bear[index] && right.bear[index] ? 1 : 0;
  }
  return { bullQualified, bearQualified };
}

function intersectQualification(
  left: { bullQualified: Uint8Array; bearQualified: Uint8Array },
  right: { bull: Uint8Array; bear: Uint8Array }
) {
  const bullQualified = new Uint8Array(left.bullQualified.length);
  const bearQualified = new Uint8Array(left.bearQualified.length);
  for (let index = 0; index < bullQualified.length; index += 1) {
    bullQualified[index] = left.bullQualified[index] && right.bull[index] ? 1 : 0;
    bearQualified[index] = left.bearQualified[index] && right.bear[index] ? 1 : 0;
  }
  return { bullQualified, bearQualified };
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;
const minuteCandles = loadCandles(path.join(root, "data", "coinbase", "sol-usd-1m.csv"));
const entryCandles = resample(minuteCandles, 15);
const hourCandles = resample(minuteCandles, 60);
const regimeCandles = resample(minuteCandles, 240);
const preparedIndicators = prepareIndicators(entryCandles, getIndicatorSettings(frozen.profile), undefined, 900, 15);

const dimensions = {
  trendWindows: [45, 60, 90, 120, 180],
  trendThresholds: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1],
  breakoutPercents: [0.15, 0.25, 0.35, 0.5, 0.65, 0.8, 1, 1.25],
  cooldownSeconds: [1_800, 3_600, 7_200, 10_800],
  emaPairs: [{ fast: 5, slow: 13 }, { fast: 9, slow: 21 }, { fast: 12, slow: 26 }],
  fourHourRegime: [false, true],
};
const primes = [2, 3, 5, 7, 11, 13];
const candidates = new Map<string, Candidate>();
for (let index = 1; candidates.size < 384; index += 1) {
  const pair = choose(dimensions.emaPairs, halton(index, primes[4]!));
  const candidate: Candidate = {
    trendWindow: choose(dimensions.trendWindows, halton(index, primes[0]!)),
    trendThreshold: choose(dimensions.trendThresholds, halton(index, primes[1]!)),
    breakoutPercent: choose(dimensions.breakoutPercents, halton(index, primes[2]!)),
    cooldownSeconds: choose(dimensions.cooldownSeconds, halton(index, primes[3]!)),
    emaFast: pair.fast,
    emaSlow: pair.slow,
    useFourHourRegime: choose(dimensions.fourHourRegime, halton(index, primes[5]!)),
  };
  candidates.set(JSON.stringify(candidate), candidate);
}
const folds = [
  { name: "2025-early", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2025-05-01T00:00:00Z") },
  { name: "2025-mid", start: Date.parse("2025-05-01T00:00:00Z"), end: Date.parse("2025-09-01T00:00:00Z") },
  { name: "2025-late", start: Date.parse("2025-09-01T00:00:00Z"), end: Date.parse("2026-01-01T00:00:00Z") },
  { name: "2026-validation", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
];
const alignmentCache = new Map<string, { bullQualified: Uint8Array; bearQualified: Uint8Array }>();
function makeQualification(entry: Candle[], hourCandlesInput: Candle[], regimeCandlesInput: Candle[], candidate: Candidate) {
  const hour = project(entry, hourCandlesInput, emaAlignment(hourCandlesInput, candidate.emaFast, candidate.emaSlow));
  return candidate.useFourHourRegime
    ? combine(hour, project(entry, regimeCandlesInput, emaAlignment(regimeCandlesInput, candidate.emaFast, candidate.emaSlow)))
    : { bullQualified: hour.bull, bearQualified: hour.bear };
}
function qualification(candidate: Candidate) {
  const key = `${candidate.emaFast}/${candidate.emaSlow}/${candidate.useFourHourRegime}`;
  const existing = alignmentCache.get(key);
  if (existing) return existing;
  const next = makeQualification(entryCandles, hourCandles, regimeCandles, candidate);
  alignmentCache.set(key, next);
  return next;
}

const control = structuredClone(frozen);
control.settings.perpsLeverage = 2;
control.settings.smartTradeProfile = "aggressive";
control.settings.mode = "all";
control.profile.leverageCap = 2;
control.profile.takeProfitRoePercent = 25;
control.profile.targetWalletRiskPercent = 0.75;
const rows = [];
let complete = 0;
for (const candidate of candidates.values()) {
  const variant: StrategyVariant = {
    name: `multi-timeframe-search-${complete + 1}`,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: "all",
    indicatorLookbackMinutes: 900,
    stopLossRoePercent: 15,
    stopLossCooldownSeconds: candidate.cooldownSeconds,
  };
  const detailed = folds.map((fold) => runBacktest({
    asset: "SOL",
    candles: entryCandles,
    preparedIndicators,
    higherTimeframeQualification: qualification(candidate),
    control,
    variant,
    costs: BASELINE_COST_MODEL,
    startMs: fold.start,
    endMs: fold.end,
    startingCapitalUsd: 1_000,
  }));
  const qualities = detailed.map(quality);
  const returns = detailed.map((result) => result.returnPercent);
  const robustScore = Math.min(...qualities) * 1.5
    + median(qualities)
    + detailed.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length * 5
    - (Math.max(...returns) - Math.min(...returns)) * 0.1;
  rows.push({
    candidate,
    robustScore,
    profitableFoldCount: detailed.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length,
    worstReturnPercent: Math.min(...returns),
    medianReturnPercent: median(returns),
    results: detailed.map((result, index) => ({ segment: folds[index]!.name, ...compact(result) })),
  });
  complete += 1;
  if (complete % 25 === 0 || complete === candidates.size) process.stdout.write(`SOL: multi-timeframe search ${complete}/${candidates.size}\n`);
}
rows.sort((left, right) => right.robustScore - left.robustScore);
const file = path.join(root, "results", "broad-search", "multi-timeframe-development.json");
fs.writeFileSync(file, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "384 deterministic Halton samples using completed 15m entry candles, 1h EMA direction, optional 4h EMA regime, 25% TP, 15% SL, 2x leverage, and four development folds ending before 2026-04-01.",
  dimensions,
  folds,
  candidateCount: candidates.size,
  rows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${file}\n`);
for (const row of rows.slice(0, 20)) process.stdout.write(`${JSON.stringify(row.candidate)} folds=${row.profitableFoldCount}/4 worst=${row.worstReturnPercent.toFixed(2)} median=${row.medianReturnPercent.toFixed(2)} score=${row.robustScore.toFixed(2)}\n`);

const survivors = rows.filter((row) => row.profitableFoldCount === 4);
const stress: CostModel = {
  ...BASELINE_COST_MODEL,
  name: "stress-costs",
  priceImpactFeeRate: 0.0005,
  slippageBps: 10,
  networkCostUsd: 0.1,
  borrowRateMultiplier: 3,
};
const confirmationPeriods = [
  { name: "development-contiguous", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
  { name: "forward", start: Date.parse("2026-04-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
  { name: "full", start: Date.parse("2025-01-01T00:00:00Z"), end: Date.parse("2026-07-20T00:00:00Z") },
];
const confirmationRows = [];
for (const asset of ["SOL", "ETH", "BTC"] as const) {
  const source = asset === "SOL"
    ? minuteCandles
    : loadCandles(path.join(root, "data", "coinbase", `${asset.toLowerCase()}-usd-1m.csv`));
  const entry = asset === "SOL" ? entryCandles : resample(source, 15);
  const hour = asset === "SOL" ? hourCandles : resample(source, 60);
  const regime = asset === "SOL" ? regimeCandles : resample(source, 240);
  const prepared = asset === "SOL"
    ? preparedIndicators
    : prepareIndicators(entry, getIndicatorSettings(frozen.profile), undefined, 900, 15);
  for (const survivor of survivors) {
    const candidate = survivor.candidate;
    const variant: StrategyVariant = {
      name: `multi-timeframe-confirmation-${asset}`,
      trendWindow: candidate.trendWindow,
      trendThreshold: candidate.trendThreshold,
      breakoutPercent: candidate.breakoutPercent,
      cooldownSeconds: candidate.cooldownSeconds,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
      directionMode: "all",
      indicatorLookbackMinutes: 900,
      stopLossRoePercent: 15,
      stopLossCooldownSeconds: candidate.cooldownSeconds,
    };
    const higherTimeframeQualification = makeQualification(entry, hour, regime, candidate);
    for (const period of confirmationPeriods) {
      const result = runBacktest({
        asset,
        candles: entry,
        preparedIndicators: prepared,
        higherTimeframeQualification,
        control,
        variant,
        costs: BASELINE_COST_MODEL,
        startMs: period.start,
        endMs: period.end,
        startingCapitalUsd: 1_000,
      });
      confirmationRows.push({ candidate, segment: period.name, ...compact(result) });
    }
    const forwardStress = runBacktest({
      asset,
      candles: entry,
      preparedIndicators: prepared,
      higherTimeframeQualification,
      control,
      variant,
      costs: stress,
      startMs: confirmationPeriods[1]!.start,
      endMs: confirmationPeriods[1]!.end,
      startingCapitalUsd: 1_000,
    });
    confirmationRows.push({ candidate, segment: "forward", ...compact(forwardStress) });
  }
  process.stdout.write(`${asset}: confirmed ${survivors.length} survivors\n`);
}
const confirmationFile = path.join(root, "results", "broad-search", "multi-timeframe-confirmation.json");
fs.writeFileSync(confirmationFile, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: file,
  survivorCount: survivors.length,
  caveat: "The post-2026-04-01 period remains diagnostic because earlier studies already inspected it; it is not a pristine holdout.",
  rows: confirmationRows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${confirmationFile}\n`);

const jointData = new Map<Asset, {
  entry: Candle[];
  hour: Candle[];
  regime: Candle[];
  prepared: ReturnType<typeof prepareIndicators>;
}>();
for (const jointAsset of ["SOL", "ETH", "BTC"] as const) {
  const source = jointAsset === "SOL"
    ? minuteCandles
    : loadCandles(path.join(root, "data", "coinbase", `${jointAsset.toLowerCase()}-usd-1m.csv`));
  const entry = jointAsset === "SOL" ? entryCandles : resample(source, 15);
  jointData.set(jointAsset, {
    entry,
    hour: jointAsset === "SOL" ? hourCandles : resample(source, 60),
    regime: jointAsset === "SOL" ? regimeCandles : resample(source, 240),
    prepared: jointAsset === "SOL"
      ? preparedIndicators
      : prepareIndicators(entry, getIndicatorSettings(frozen.profile), undefined, 900, 15),
  });
}
const jointRows: Array<{
  candidate: Candidate;
  robustScore: number;
  profitableFoldCount: number;
  assetProfitableFoldCounts: Record<string, number>;
  worstReturnPercent: number;
  medianReturnPercent: number;
  worstDrawdownPercent: number;
  results: unknown[];
}> = [];
complete = 0;
for (const candidate of candidates.values()) {
  const variant: StrategyVariant = {
    name: `multi-timeframe-joint-${complete + 1}`,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: "all",
    indicatorLookbackMinutes: 900,
    stopLossRoePercent: 15,
    stopLossCooldownSeconds: candidate.cooldownSeconds,
  };
  const detailed = (["SOL", "ETH", "BTC"] as const).flatMap((jointAsset) => {
    const data = jointData.get(jointAsset)!;
    const higherTimeframeQualification = makeQualification(data.entry, data.hour, data.regime, candidate);
    return folds.map((fold) => ({
      jointAsset,
      fold: fold.name,
      result: runBacktest({
        asset: jointAsset,
        candles: data.entry,
        preparedIndicators: data.prepared,
        higherTimeframeQualification,
        control,
        variant,
        costs: BASELINE_COST_MODEL,
        startMs: fold.start,
        endMs: fold.end,
        startingCapitalUsd: 1_000,
      }),
    }));
  });
  const qualities = detailed.map(({ result }) => quality(result));
  const returns = detailed.map(({ result }) => result.returnPercent);
  const profitableFoldCount = detailed.filter(({ result }) => result.returnPercent > 0 && result.profitFactor > 1).length;
  const assetProfitableFoldCounts = Object.fromEntries((["SOL", "ETH", "BTC"] as const).map((jointAsset) => [
    jointAsset,
    detailed.filter((row) => row.jointAsset === jointAsset && row.result.returnPercent > 0 && row.result.profitFactor > 1).length,
  ]));
  const robustScore = Math.min(...qualities) * 2
    + median(qualities)
    + profitableFoldCount * 5
    + Math.min(...Object.values(assetProfitableFoldCounts)) * 8
    - (Math.max(...returns) - Math.min(...returns)) * 0.1;
  jointRows.push({
    candidate,
    robustScore,
    profitableFoldCount,
    assetProfitableFoldCounts,
    worstReturnPercent: Math.min(...returns),
    medianReturnPercent: median(returns),
    worstDrawdownPercent: Math.max(...detailed.map(({ result }) => result.maxDrawdownPercent)),
    results: detailed.map(({ fold, result }) => ({ segment: fold, ...compact(result) })),
  });
  complete += 1;
  if (complete % 25 === 0 || complete === candidates.size) process.stdout.write(`joint multi-asset search ${complete}/${candidates.size}\n`);
}
jointRows.sort((left, right) => right.robustScore - left.robustScore);
const jointFile = path.join(root, "results", "broad-search", "multi-timeframe-joint-development.json");
fs.writeFileSync(jointFile, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "The same 384 candidates scored jointly across four chronological development folds for each of SOL, ETH, and BTC; no post-2026-04-01 data used for ranking.",
  allTwelveProfitableCount: jointRows.filter((row) => row.profitableFoldCount === 12).length,
  atLeastThreePerAssetCount: jointRows.filter((row) => Object.values(row.assetProfitableFoldCounts).every((count) => count >= 3)).length,
  rows: jointRows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${jointFile}\n`);
for (const row of jointRows.slice(0, 20)) process.stdout.write(`${JSON.stringify(row.candidate)} folds=${row.profitableFoldCount}/12 assets=${JSON.stringify(row.assetProfitableFoldCounts)} worst=${row.worstReturnPercent.toFixed(2)} median=${row.medianReturnPercent.toFixed(2)} DD=${row.worstDrawdownPercent.toFixed(2)} score=${row.robustScore.toFixed(2)}\n`);

const jointLeaders = jointRows.slice(0, 12);
const jointConfirmationRows = [];
for (const leader of jointLeaders) {
  const candidate = leader.candidate;
  for (const jointAsset of ["SOL", "ETH", "BTC"] as const) {
    const data = jointData.get(jointAsset)!;
    const higherTimeframeQualification = makeQualification(data.entry, data.hour, data.regime, candidate);
    const variant: StrategyVariant = {
      name: `multi-timeframe-joint-confirmation-${jointAsset}`,
      trendWindow: candidate.trendWindow,
      trendThreshold: candidate.trendThreshold,
      breakoutPercent: candidate.breakoutPercent,
      cooldownSeconds: candidate.cooldownSeconds,
      useIndicators: true,
      useLearnedConfirmation: true,
      useDecisionLayer: true,
      directionMode: "all",
      indicatorLookbackMinutes: 900,
      stopLossRoePercent: 15,
      stopLossCooldownSeconds: candidate.cooldownSeconds,
    };
    for (const costs of [BASELINE_COST_MODEL, stress]) {
      const result = runBacktest({
        asset: jointAsset,
        candles: data.entry,
        preparedIndicators: data.prepared,
        higherTimeframeQualification,
        control,
        variant,
        costs,
        startMs: Date.parse("2026-04-01T00:00:00Z"),
        endMs: Date.parse("2026-07-20T00:00:00Z"),
        startingCapitalUsd: 1_000,
      });
      jointConfirmationRows.push({ candidate, developmentRank: jointRows.indexOf(leader) + 1, ...compact(result) });
    }
  }
}
const jointConfirmationFile = path.join(root, "results", "broad-search", "multi-timeframe-joint-confirmation.json");
fs.writeFileSync(jointConfirmationFile, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: jointFile,
  leaderCount: jointLeaders.length,
  caveat: "The forward period is diagnostic rather than pristine because earlier studies inspected it.",
  rows: jointConfirmationRows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${jointConfirmationFile}\n`);

type SolCandidate = Candidate & {
  btcConfirmation: "none" | "1h" | "1h+4h";
};
const solDimensions = {
  trendWindows: [45, 60, 75, 90, 120, 150, 180],
  trendThresholds: [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25],
  breakoutPercents: [0.25, 0.35, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2],
  cooldownSeconds: [1_800, 3_600, 7_200, 10_800],
  emaPairs: [{ fast: 5, slow: 13 }, { fast: 8, slow: 21 }, { fast: 9, slow: 21 }, { fast: 12, slow: 26 }],
  fourHourRegime: [false, true],
  btcConfirmation: ["none", "1h", "1h+4h"] as const,
};
const solPrimes = [2, 3, 5, 7, 11, 13, 17];
const solCandidates = new Map<string, SolCandidate>();
for (let index = 1; solCandidates.size < 1_024; index += 1) {
  const pair = choose(solDimensions.emaPairs, halton(index, solPrimes[4]!));
  const candidate: SolCandidate = {
    trendWindow: choose(solDimensions.trendWindows, halton(index, solPrimes[0]!)),
    trendThreshold: choose(solDimensions.trendThresholds, halton(index, solPrimes[1]!)),
    breakoutPercent: choose(solDimensions.breakoutPercents, halton(index, solPrimes[2]!)),
    cooldownSeconds: choose(solDimensions.cooldownSeconds, halton(index, solPrimes[3]!)),
    emaFast: pair.fast,
    emaSlow: pair.slow,
    useFourHourRegime: choose(solDimensions.fourHourRegime, halton(index, solPrimes[5]!)),
    btcConfirmation: choose(solDimensions.btcConfirmation, halton(index, solPrimes[6]!)),
  };
  solCandidates.set(JSON.stringify(candidate), candidate);
}
const solData = jointData.get("SOL")!;
const btcData = jointData.get("BTC")!;
const solQualificationCache = new Map<string, { bullQualified: Uint8Array; bearQualified: Uint8Array }>();
function solQualification(candidate: SolCandidate) {
  const key = `${candidate.emaFast}/${candidate.emaSlow}/${candidate.useFourHourRegime}/${candidate.btcConfirmation}`;
  const cached = solQualificationCache.get(key);
  if (cached) return cached;
  let result = makeQualification(solData.entry, solData.hour, solData.regime, candidate);
  if (candidate.btcConfirmation !== "none") {
    const btcHour = project(solData.entry, btcData.hour, emaAlignment(btcData.hour, candidate.emaFast, candidate.emaSlow));
    result = intersectQualification(result, btcHour);
    if (candidate.btcConfirmation === "1h+4h") {
      const btcRegime = project(solData.entry, btcData.regime, emaAlignment(btcData.regime, candidate.emaFast, candidate.emaSlow));
      result = intersectQualification(result, btcRegime);
    }
  }
  solQualificationCache.set(key, result);
  return result;
}
const solRows: Array<{
  candidate: SolCandidate;
  robustScore: number;
  profitableFoldCount: number;
  worstReturnPercent: number;
  medianReturnPercent: number;
  worstDrawdownPercent: number;
  totalTrades: number;
  results: unknown[];
}> = [];
complete = 0;
for (const candidate of solCandidates.values()) {
  const variant: StrategyVariant = {
    name: `sol-specialized-${complete + 1}`,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: "all",
    indicatorLookbackMinutes: 900,
    stopLossRoePercent: 15,
    stopLossCooldownSeconds: candidate.cooldownSeconds,
  };
  const detailed = folds.map((fold) => runBacktest({
    asset: "SOL",
    candles: solData.entry,
    preparedIndicators: solData.prepared,
    higherTimeframeQualification: solQualification(candidate),
    control,
    variant,
    costs: BASELINE_COST_MODEL,
    startMs: fold.start,
    endMs: fold.end,
    startingCapitalUsd: 1_000,
  }));
  const qualities = detailed.map(quality);
  const returns = detailed.map((result) => result.returnPercent);
  const robustScore = Math.min(...qualities) * 1.75
    + median(qualities)
    + detailed.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length * 6
    - (Math.max(...returns) - Math.min(...returns)) * 0.12;
  solRows.push({
    candidate,
    robustScore,
    profitableFoldCount: detailed.filter((result) => result.returnPercent > 0 && result.profitFactor > 1).length,
    worstReturnPercent: Math.min(...returns),
    medianReturnPercent: median(returns),
    worstDrawdownPercent: Math.max(...detailed.map((result) => result.maxDrawdownPercent)),
    totalTrades: detailed.reduce((sum, result) => sum + result.tradeCount, 0),
    results: detailed.map((result, index) => ({ segment: folds[index]!.name, ...compact(result) })),
  });
  complete += 1;
  if (complete % 50 === 0 || complete === solCandidates.size) process.stdout.write(`SOL specialized search ${complete}/${solCandidates.size}\n`);
}
solRows.sort((left, right) => right.robustScore - left.robustScore);
const solFile = path.join(root, "results", "broad-search", "sol-specialized-development.json");
fs.writeFileSync(solFile, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  methodology: "1,024 deterministic SOL-specific candidates using 15m SOL entries, SOL 1h and optional 4h EMA regime, optional BTC 1h/4h cross-market confirmation, fixed 25% TP, 15% SL, and 2x leverage. Ranked only on four development folds ending before 2026-04-01.",
  dimensions: solDimensions,
  fourFoldSurvivorCount: solRows.filter((row) => row.profitableFoldCount === 4).length,
  rows: solRows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${solFile}\n`);
for (const row of solRows.slice(0, 20)) process.stdout.write(`${JSON.stringify(row.candidate)} folds=${row.profitableFoldCount}/4 worst=${row.worstReturnPercent.toFixed(2)} median=${row.medianReturnPercent.toFixed(2)} DD=${row.worstDrawdownPercent.toFixed(2)} trades=${row.totalTrades} score=${row.robustScore.toFixed(2)}\n`);

const solLeaders = solRows.filter((row) => row.profitableFoldCount === 4).slice(0, 30);
const solConfirmationRows = [];
for (let rank = 0; rank < solLeaders.length; rank += 1) {
  const candidate = solLeaders[rank]!.candidate;
  const variant: StrategyVariant = {
    name: `sol-specialized-confirmation-${rank + 1}`,
    trendWindow: candidate.trendWindow,
    trendThreshold: candidate.trendThreshold,
    breakoutPercent: candidate.breakoutPercent,
    cooldownSeconds: candidate.cooldownSeconds,
    useIndicators: true,
    useLearnedConfirmation: true,
    useDecisionLayer: true,
    directionMode: "all",
    indicatorLookbackMinutes: 900,
    stopLossRoePercent: 15,
    stopLossCooldownSeconds: candidate.cooldownSeconds,
  };
  for (const costs of [BASELINE_COST_MODEL, stress]) {
    const result = runBacktest({
      asset: "SOL",
      candles: solData.entry,
      preparedIndicators: solData.prepared,
      higherTimeframeQualification: solQualification(candidate),
      control,
      variant,
      costs,
      startMs: Date.parse("2026-04-01T00:00:00Z"),
      endMs: Date.parse("2026-07-20T00:00:00Z"),
      startingCapitalUsd: 1_000,
    });
    solConfirmationRows.push({ candidate, developmentRank: rank + 1, ...compact(result) });
  }
}
const solConfirmationFile = path.join(root, "results", "broad-search", "sol-specialized-confirmation.json");
fs.writeFileSync(solConfirmationFile, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: solFile,
  leaderCount: solLeaders.length,
  caveat: "The forward period is diagnostic rather than pristine because earlier studies inspected it.",
  rows: solConfirmationRows,
}, null, 2)}\n`);
process.stdout.write(`Saved ${solConfirmationFile}\n`);
