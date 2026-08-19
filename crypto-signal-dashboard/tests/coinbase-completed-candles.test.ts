import assert from "node:assert/strict";
import test from "node:test";

import { parseCompletedCoinbaseMinuteCandles } from "../lib/price/coinbase";

test("Coinbase candle parsing excludes the unfinished current minute", () => {
  const observedAt = Date.parse("2026-08-19T17:06:14.000Z");
  const currentMinute = Math.floor(Date.parse("2026-08-19T17:06:00.000Z") / 1_000);
  const previousMinute = Math.floor(Date.parse("2026-08-19T17:05:00.000Z") / 1_000);
  const points = parseCompletedCoinbaseMinuteCandles([
    [currentMinute, 81.48, 81.56, 81.56, 81.55, 12],
    [previousMinute, 81.45, 81.56, 81.45, 81.56, 8_872],
  ], observedAt);

  assert.equal(points.length, 1);
  assert.equal(points[0]?.t, previousMinute * 1_000);
  assert.equal(points[0]?.v, 81.56);
  assert.equal(points[0]?.volume, 8_872);
});

test("completed Coinbase candles stay ordered and malformed rows are ignored", () => {
  const observedAt = Date.parse("2026-08-19T17:08:00.000Z");
  const minuteFive = Math.floor(Date.parse("2026-08-19T17:05:00.000Z") / 1_000);
  const minuteSix = minuteFive + 60;
  const points = parseCompletedCoinbaseMinuteCandles([
    [minuteSix, 81.4, 81.6, 81.5, 81.45, 100],
    ["bad"],
    [minuteFive, 81.3, 81.5, 81.4, 81.5, 200],
  ], observedAt);

  assert.deepEqual(points.map((point) => point.t), [minuteFive * 1_000, minuteSix * 1_000]);
});
