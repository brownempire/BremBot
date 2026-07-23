import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.exchange.coinbase.com";
const PRODUCTS = (process.env.COINBASE_PRODUCTS ?? "SOL-USD,ETH-USD,BTC-USD")
  .split(",")
  .map((product) => product.trim().toUpperCase())
  .filter(Boolean);
const MAX_MINUTES = 299;
const REQUEST_DELAY_MS = Number(process.env.COINBASE_REQUEST_DELAY_MS ?? 650);
const MIN_GAP_MINUTES = Number(process.env.COINBASE_MIN_GAP_MINUTES ?? 1);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function validate(entry) {
  if (!Array.isArray(entry) || entry.length < 6) return null;
  const [timestamp, low, high, open, close, volume] = entry.map(Number);
  if (![timestamp, low, high, open, close, volume].every(Number.isFinite)) return null;
  if (timestamp <= 0 || low <= 0 || high <= 0 || open <= 0 || close <= 0 || volume < 0) return null;
  if (low > high || open < low || open > high || close < low || close > high) return null;
  return { timestamp, open, high, low, close, volume };
}

async function fetchRange(product, start, end) {
  const query = new URLSearchParams({
    granularity: "60",
    start: new Date(start * 1_000).toISOString(),
    end: new Date(end * 1_000).toISOString(),
  });
  let delay = 1_000;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await fetch(`${API}/products/${product}/candles?${query}`, {
      headers: { Accept: "application/json", "User-Agent": "BremLogic-Backtest-Repair/1.0" },
    });
    if (response.ok) {
      const payload = await response.json();
      if (Array.isArray(payload) && payload.length > 0) return payload.map(validate).filter(Boolean);
      // A missing one-minute bucket can legitimately mean Coinbase recorded no
      // ticks. Confirm once, then preserve it. Multi-minute empty ranges on
      // these liquid products are retried as transient API failures.
      if (Array.isArray(payload) && attempt >= 2) return [];
    } else if (response.status !== 429 && response.status < 500) {
      throw new Error(`${product} gap repair failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    await sleep(delay);
    delay = Math.min(30_000, delay * 2);
  }
  return [];
}

function loadCsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  if (lines.shift() !== "timestamp,open,high,low,close,volume") throw new Error(`Unexpected header in ${file}`);
  return lines.map((line) => {
    const [timestamp, open, high, low, close, volume] = line.split(",").map(Number);
    return { timestamp, open, high, low, close, volume };
  });
}

function gaps(candles, requestedStart, requestedEnd) {
  const ranges = [];
  let expected = requestedStart;
  for (const candle of candles) {
    if (candle.timestamp > expected) ranges.push({ start: expected, end: candle.timestamp });
    expected = Math.max(expected, candle.timestamp + 60);
  }
  if (expected < requestedEnd) ranges.push({ start: expected, end: requestedEnd });
  return ranges;
}

const outputDir = path.resolve(arg("data", "./research/backtest/data/coinbase"));
const manifestFile = path.join(outputDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

for (const product of PRODUCTS) {
  const slug = product.toLowerCase();
  const csvFile = path.join(outputDir, `${slug}-1m.csv`);
  const stateFile = path.join(outputDir, `${slug}-state.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!state.complete) throw new Error(`${product} download is not complete; repair only runs on a frozen dataset.`);
  const original = loadCsv(csvFile);
  const byTimestamp = new Map(original.map((candle) => [candle.timestamp, candle]));
  const allOriginalGaps = gaps(original, state.requestedStart, state.requestedEnd);
  const originalGaps = allOriginalGaps.filter((gap) => (gap.end - gap.start) / 60 >= MIN_GAP_MINUTES);
  process.stdout.write(`${product}: repairing ${originalGaps.length} of ${allOriginalGaps.length} gap ranges (minimum ${MIN_GAP_MINUTES} minute(s))\n`);

  for (const range of originalGaps) {
    for (let start = range.start; start < range.end; start += MAX_MINUTES * 60) {
      const end = Math.min(range.end, start + MAX_MINUTES * 60);
      const repaired = await fetchRange(product, start, end);
      for (const candle of repaired) {
        if (candle.timestamp >= range.start && candle.timestamp < range.end) byTimestamp.set(candle.timestamp, candle);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const merged = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  const remaining = gaps(merged, state.requestedStart, state.requestedEnd);
  const tmp = `${csvFile}.repairing`;
  const rows = [
    "timestamp,open,high,low,close,volume",
    ...merged.map((candle) => `${candle.timestamp},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume}`),
  ];
  fs.writeFileSync(tmp, `${rows.join("\n")}\n`);
  fs.renameSync(tmp, csvFile);
  state.rows = merged.length;
  state.firstTimestamp = merged[0]?.timestamp ?? null;
  state.lastTimestamp = merged[merged.length - 1]?.timestamp ?? null;
  state.missingMinutes = remaining.reduce((sum, gap) => sum + (gap.end - gap.start) / 60, 0);
  state.repairedAt = new Date().toISOString();
  state.sha256 = sha256(csvFile);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const manifestState = manifest.products.find((item) => item.product === product);
  if (manifestState) Object.assign(manifestState, state);
  process.stdout.write(`${product}: ${merged.length - original.length} candles restored; ${state.missingMinutes} no-trade minutes remain\n`);
}

manifest.repairedAt = new Date().toISOString();
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Updated verified manifest ${manifestFile}\n`);
