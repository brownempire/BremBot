import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_INDICATOR_SETTINGS,
  computeIndicatorSnapshot,
  scoreIndicatorSnapshot,
} from "../lib/signal/indicators";

function trendingCandles(direction: 1 | -1) {
  return Array.from({ length: 70 }, (_, index) => {
    const trend = direction * index * 0.12;
    const wave = Math.sin(index / 2) * 0.18;
    const close = 100 + trend + wave;
    return {
      t: 1_700_000_000_000 + index * 60_000,
      o: close - direction * 0.05,
      h: close + 0.18,
      l: close - 0.18,
      v: close,
      volume: index === 69 ? 180 : 100 + index % 5,
    };
  });
}

test("indicator snapshot calculates the configured EMA, MACD, ADX, volume, ATR, and Bollinger features", () => {
  const snapshot = computeIndicatorSnapshot(trendingCandles(1));
  assert.ok(snapshot.emaFast !== null && snapshot.emaSlow !== null && snapshot.emaFast > snapshot.emaSlow);
  assert.ok(snapshot.macdHistogram !== null);
  assert.ok(snapshot.adx !== null && snapshot.plusDi !== null && snapshot.plusDi > (snapshot.minusDi ?? 0));
  assert.ok(snapshot.atrPercent !== null && snapshot.atrPercent > 0);
  assert.ok(snapshot.volumeRatio !== null && snapshot.volumeRatio > 1.1);
  assert.ok(snapshot.bollingerBandwidthPercent !== null && snapshot.bollingerPosition !== null);
});

test("directional evidence reaches the baseline score while an extreme RSI veto still blocks entry", () => {
  const snapshot = computeIndicatorSnapshot(trendingCandles(1));
  const scored = scoreIndicatorSnapshot({ ...snapshot, rsi: 62 }, "bullish");
  assert.equal(scored.qualified, true);
  assert.ok(scored.score >= BASE_INDICATOR_SETTINGS.minimumScore);
  assert.ok(scored.tags.includes("EMA_ALIGNED"));

  const vetoed = scoreIndicatorSnapshot({ ...snapshot, rsi: 78 }, "bullish");
  assert.equal(vetoed.vetoed, true);
  assert.equal(vetoed.qualified, false);
  assert.ok(vetoed.tags.includes("RSI_EXTREME_VETO"));
});
