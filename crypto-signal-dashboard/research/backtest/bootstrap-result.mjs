import fs from "node:fs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))] ?? 0;
}

const file = arg("file", "");
if (!file) throw new Error("Supply --file with a detailed BacktestResult JSON file.");
const iterations = Number(arg("iterations", "10000"));
const blockLength = Number(arg("block", "5"));
const seed = Number(arg("seed", "20260720"));
const result = JSON.parse(fs.readFileSync(file, "utf8"));
const trades = result.trades ?? [];
if (trades.length < 5) throw new Error(`Only ${trades.length} trades; bootstrap inference would be misleading.`);

let capital = result.startingCapitalUsd;
const returns = trades.map((trade) => {
  const tradeReturn = capital > 0 ? trade.netPnlUsd / capital : -1;
  capital = Math.max(0, capital + trade.netPnlUsd);
  return tradeReturn;
});
const random = mulberry32(seed);
const finalReturns = [];
const maxDrawdowns = [];
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const sampled = [];
  while (sampled.length < returns.length) {
    const start = Math.floor(random() * returns.length);
    for (let offset = 0; offset < blockLength && sampled.length < returns.length; offset += 1) {
      sampled.push(returns[(start + offset) % returns.length]);
    }
  }
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const tradeReturn of sampled) {
    equity = Math.max(0, equity * (1 + tradeReturn));
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  finalReturns.push((equity - 1) * 100);
  maxDrawdowns.push(maxDrawdown * 100);
}
finalReturns.sort((a, b) => a - b);
maxDrawdowns.sort((a, b) => a - b);
const output = {
  source: file,
  seed,
  iterations,
  blockLength,
  tradeCount: trades.length,
  caveat: "Stationary circular trade-block bootstrap; it measures sequence uncertainty in this historical trade sample, not future-market certainty.",
  returnPercent: {
    p025: quantile(finalReturns, 0.025),
    median: quantile(finalReturns, 0.5),
    p975: quantile(finalReturns, 0.975),
    probabilityNonPositive: finalReturns.filter((value) => value <= 0).length / finalReturns.length,
  },
  maxDrawdownPercent: {
    p50: quantile(maxDrawdowns, 0.5),
    p95: quantile(maxDrawdowns, 0.95),
    p975: quantile(maxDrawdowns, 0.975),
  },
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputFile = arg("out", "");
if (outputFile) fs.writeFileSync(outputFile, serialized);
process.stdout.write(serialized);
