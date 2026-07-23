import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  BASELINE_COST_MODEL,
  runBacktest,
  type Candle,
  type FrozenControl,
  type PreparedIndicators,
  type StrategyVariant,
} from "./model";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const control = JSON.parse(fs.readFileSync(path.join(root, "frozen-control.json"), "utf8")) as FrozenControl;

function syntheticCandles(count: number): Candle[] {
  const start = Date.parse("2026-01-01T00:00:00Z");
  const candles: Candle[] = [];
  let previous = 100;
  for (let index = 0; index < count; index += 1) {
    const close = index < 70 ? 100 : index === 70 ? 100.8 : previous * 1.00005;
    candles.push({
      t: start + index * 60_000,
      o: previous,
      h: Math.max(previous, close) * 1.0002,
      l: Math.min(previous, close) * 0.9998,
      v: close,
      volume: 1_000,
    });
    previous = close;
  }
  return candles;
}

function emptyIndicators(length: number): PreparedIndicators {
  return {
    ready: new Uint8Array(length),
    bullQualified: new Uint8Array(length),
    bearQualified: new Uint8Array(length),
    bullVetoed: new Uint8Array(length),
    bearVetoed: new Uint8Array(length),
    bullScore: new Float32Array(length),
    bearScore: new Float32Array(length),
  };
}

const variant: StrategyVariant = {
  name: "harness-validation",
  trendWindow: 15,
  trendThreshold: 0.14,
  breakoutPercent: 0.19,
  cooldownSeconds: 180,
  useIndicators: false,
  useLearnedConfirmation: false,
  useDecisionLayer: false,
};

function replay(candles: Candle[], endOffset = 0) {
  return runBacktest({
    asset: "SOL",
    candles,
    preparedIndicators: emptyIndicators(candles.length),
    control,
    variant,
    costs: BASELINE_COST_MODEL,
    startMs: candles[60]!.t,
    endMs: candles[candles.length - 1 - endOffset]!.t + 60_000,
  });
}

const candles = syntheticCandles(180);
const first = replay(candles);
const second = replay(candles);
assert.deepEqual(first, second, "Identical replay input must produce byte-equivalent results.");
assert.ok(first.tradeCount > 0, "Synthetic signal should create at least one trade.");
assert.ok(first.trades.every((trade) => trade.enteredAt > trade.signalAt), "Every entry must occur after its signal candle.");

const prefix = candles.slice(0, 140);
const prefixResult = replay(prefix);
const fullBeforePrefixEnd = first.trades.filter((trade) => trade.exitedAt <= prefix[prefix.length - 1]!.t + 60_000);
assert.deepEqual(
  prefixResult.trades.filter((trade) => trade.exitReason !== "end-of-period"),
  fullBeforePrefixEnd,
  "Appending future candles must not change trades already closed in the prefix."
);

const corrupt = structuredClone(candles);
const last = corrupt[corrupt.length - 1]!;
last.h *= 100;
last.l /= 100;
const earlierEnd = 30;
assert.deepEqual(
  replay(candles, earlierEnd),
  replay(corrupt, earlierEnd),
  "Candles beyond the requested end must not affect a replay."
);

assert.throws(
  () => runBacktest({
    asset: "SOL",
    candles,
    preparedIndicators: emptyIndicators(candles.length),
    control,
    variant,
    costs: BASELINE_COST_MODEL,
    startMs: candles[candles.length - 1]!.t + 60_000,
    endMs: candles[candles.length - 1]!.t + 120_000,
  }),
  /after the available candle history/,
  "An out-of-range start must fail instead of silently replaying an arbitrary index."
);

const source = fs.readFileSync(path.resolve(root, "../../lib/perps/userScopedRisk.ts"), "utf8");
assert.ok(!source.includes("maxDailyLossPct"), "Audit expectation changed: production now appears to enforce daily loss.");

process.stdout.write(JSON.stringify({
  status: "passed",
  assertions: 7,
  syntheticTrades: first.tradeCount,
  notes: [
    "deterministic replay",
    "next-candle entry",
    "closed-trade prefix stability",
    "requested-end isolation",
    "out-of-range rejection",
    "production daily-loss non-enforcement audit",
  ],
}, null, 2) + "\n");
