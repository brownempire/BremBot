import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.exchange.coinbase.com";
const PRODUCTS = (process.env.COINBASE_PRODUCTS ?? "SOL-USD,ETH-USD,BTC-USD")
  .split(",")
  .map((product) => product.trim().toUpperCase())
  .filter(Boolean);
const GRANULARITY_SECONDS = 60;
const CHUNK_MINUTES = 299;
const REQUEST_DELAY_MS = Number(process.env.COINBASE_REQUEST_DELAY_MS ?? 650);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseUtc(value, name) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid --${name}: ${value}`);
  return Math.floor(timestamp / 60_000) * 60;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChunk(product, startSec, endSec) {
  const query = new URLSearchParams({
    granularity: String(GRANULARITY_SECONDS),
    start: new Date(startSec * 1000).toISOString(),
    end: new Date(endSec * 1000).toISOString(),
  });
  let delay = 1_000;
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(`${API}/products/${product}/candles?${query}`, {
        headers: { Accept: "application/json", "User-Agent": "BremLogic-Backtest/1.0" },
      });
      if (response.ok) {
        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error("Coinbase returned a non-array candle payload.");
        // All selected products are continuously traded. An entirely empty
        // multi-hour historical response is a transient API failure, not a
        // valid no-trade interval; accepting one silently corrupts the replay.
        if (payload.length === 0 && endSec - startSec >= 10 * 60) {
          throw new Error(`${product} returned an empty historical candle chunk.`);
        }
        return payload;
      }
      const body = await response.text();
      lastError = new Error(`${product} HTTP ${response.status}: ${body.slice(0, 200)}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
    }
    await sleep(delay);
    delay = Math.min(30_000, delay * 2);
  }
  throw lastError ?? new Error(`${product} candle request failed.`);
}

function validateCandle(entry) {
  if (!Array.isArray(entry) || entry.length < 6) return null;
  const [timestamp, low, high, open, close, volume] = entry.map(Number);
  if (![timestamp, low, high, open, close, volume].every(Number.isFinite)) return null;
  if (timestamp <= 0 || low <= 0 || high <= 0 || open <= 0 || close <= 0 || volume < 0) return null;
  if (low > high || open < low || open > high || close < low || close > high) return null;
  return { timestamp, open, high, low, close, volume };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

async function downloadProduct({ product, startSec, endSec, outputDir }) {
  const slug = product.toLowerCase();
  const csvFile = path.join(outputDir, `${slug}-1m.csv`);
  const stateFile = path.join(outputDir, `${slug}-state.json`);
  const initial = {
    product,
    requestedStart: startSec,
    requestedEnd: endSec,
    nextStart: startSec,
    lastTimestamp: null,
    firstTimestamp: null,
    rows: 0,
    duplicateRows: 0,
    invalidRows: 0,
    missingMinutes: 0,
    requests: 0,
    complete: false,
  };
  const state = readJson(stateFile, initial);
  if (state.requestedStart !== startSec || state.requestedEnd !== endSec || state.product !== product) {
    throw new Error(`${product} resume state does not match the requested range.`);
  }
  if (!fs.existsSync(csvFile)) {
    fs.writeFileSync(csvFile, "timestamp,open,high,low,close,volume\n");
  }
  if (state.complete) return state;

  const stream = fs.createWriteStream(csvFile, { flags: "a" });
  try {
    while (state.nextStart < endSec) {
      const chunkEnd = Math.min(endSec, state.nextStart + CHUNK_MINUTES * 60);
      const raw = await fetchChunk(product, state.nextStart, chunkEnd);
      const candles = raw
        .map(validateCandle)
        .filter(Boolean)
        .filter((candle) => candle.timestamp >= startSec && candle.timestamp < endSec)
        .sort((left, right) => left.timestamp - right.timestamp);

      for (const candle of candles) {
        if (state.lastTimestamp !== null && candle.timestamp <= state.lastTimestamp) {
          state.duplicateRows += 1;
          continue;
        }
        if (state.lastTimestamp !== null && candle.timestamp > state.lastTimestamp + GRANULARITY_SECONDS) {
          state.missingMinutes += Math.floor((candle.timestamp - state.lastTimestamp) / GRANULARITY_SECONDS) - 1;
        }
        stream.write(`${candle.timestamp},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume}\n`);
        state.firstTimestamp ??= candle.timestamp;
        state.lastTimestamp = candle.timestamp;
        state.rows += 1;
      }
      state.invalidRows += raw.length - raw.map(validateCandle).filter(Boolean).length;
      state.requests += 1;
      state.nextStart = chunkEnd;
      writeJson(stateFile, state);
      if (state.requests % 100 === 0) {
        const progress = ((state.nextStart - startSec) / (endSec - startSec) * 100).toFixed(1);
        process.stdout.write(`${product}: ${progress}% (${state.rows} rows, ${state.missingMinutes} missing minutes)\n`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
  }

  state.complete = true;
  state.completedAt = new Date().toISOString();
  state.sha256 = sha256(csvFile);
  writeJson(stateFile, state);
  process.stdout.write(`${product}: complete (${state.rows} rows, SHA-256 ${state.sha256})\n`);
  return state;
}

const startSec = parseUtc(arg("start", "2025-01-01T00:00:00Z"), "start");
const endSec = parseUtc(arg("end", "2026-07-20T00:00:00Z"), "end");
if (endSec <= startSec) throw new Error("--end must be after --start.");
const outputDir = path.resolve(arg("out", "./data/coinbase"));
fs.mkdirSync(outputDir, { recursive: true });

const states = await Promise.all(PRODUCTS.map((product) => downloadProduct({ product, startSec, endSec, outputDir })));
const manifest = {
  source: API,
  downloadedAt: new Date().toISOString(),
  requestedStart: startSec,
  requestedEnd: endSec,
  granularitySeconds: GRANULARITY_SECONDS,
  products: states,
};
writeJson(path.join(outputDir, "manifest.json"), manifest);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
