import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SIGNAL_HISTORY, normalizeSignalHistory, VISIBLE_SIGNAL_ROWS } from "../lib/signal/history";

function signal(index: number) {
  return {
    id: `SOL/USD-trend-${index}`,
    symbol: "SOL/USD",
    type: "trend" as const,
    direction: index % 2 === 0 ? "bullish" as const : "bearish" as const,
    confidence: 0.7,
    summary: `Signal ${index}`,
    timestamp: 1_800_000_000_000 + index,
  };
}

test("wallet signal history keeps only the newest 20 signals", () => {
  assert.equal(VISIBLE_SIGNAL_ROWS, 5);
  const history = normalizeSignalHistory(Array.from({ length: 25 }, (_, index) => signal(index)));
  assert.equal(history.length, MAX_SIGNAL_HISTORY);
  assert.equal(history[0]?.id, signal(24).id);
  assert.equal(history.at(-1)?.id, signal(5).id);
});

test("wallet signal history deduplicates IDs and rejects malformed entries", () => {
  const history = normalizeSignalHistory([
    signal(1),
    signal(1),
    { ...signal(2), confidence: 2 },
    { ...signal(3), type: "scalp" },
  ]);
  assert.deepEqual(history.map((item) => item.id), [signal(1).id]);
});
