import assert from "node:assert/strict";
import test from "node:test";

import { fetchJupiterPerpsTradeHistory, type JupiterPerpsPosition, type JupiterPerpsTrade } from "../lib/jupiterPerps";
import { buildPerpsPnlSummary, calculatePnlSince } from "../lib/perps/pnl";

function trade(overrides: Partial<JupiterPerpsTrade>): JupiterPerpsTrade {
  return {
    id: "trade",
    source: "live-api",
    positionPubkey: "position",
    marketSymbol: "SOL",
    marketName: "Jupiter SOL Perps",
    side: "long",
    action: "Close",
    orderType: "Market",
    price: 100,
    sizeUsd: 100,
    collateralUsdDelta: 0,
    feeUsd: 0,
    pnl: 0,
    pnlPercentage: 0,
    txHash: null,
    lastUpdated: null,
    createdAt: 1,
    ...overrides,
  };
}

test("Perps PnL combines fee-adjusted realized history with current open-position PnL", () => {
  const trades = [
    trade({ id: "entry", action: "Increase", pnl: null, feeUsd: 0.25, createdAt: 1_000 }),
    trade({ id: "win", pnl: 12.5, feeUsd: 0.5, createdAt: 2_000 }),
    trade({ id: "loss", pnl: -3, feeUsd: 0.4, createdAt: 3_000 }),
  ];
  const positions = [{ unrealizedPnl: 4.75 }] as JupiterPerpsPosition[];
  const summary = buildPerpsPnlSummary(trades, positions, 4_000);

  assert.equal(summary.realizedPnlUsd, 9.25);
  assert.equal(summary.unrealizedPnlUsd, 4.75);
  assert.equal(summary.totalPnlUsd, 14);
  assert.deepEqual(summary.points.map((point) => point.v), [-0.25, 12.25, 9.25, 14]);
});

test("range PnL uses the last cumulative value before the cutoff", () => {
  const points = [
    { t: 1_000, v: 2 },
    { t: 2_000, v: 5 },
    { t: 3_000, v: 4 },
  ];
  assert.equal(calculatePnlSince(points, 1_500), 2);
  assert.equal(calculatePnlSince(points, 2_500), -1);
  assert.equal(calculatePnlSince(points, 500), 4);
});

test("Jupiter Perps history follows start/end pagination until the reported account count is complete", async (context) => {
  const originalFetch = global.fetch;
  const starts: number[] = [];
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const start = Number(url.searchParams.get("start") ?? 0);
    starts.push(start);
    const rows = Array.from({ length: start === 0 ? 10 : 2 }, (_, index) => ({
      txHash: `tx-${start + index}`,
      positionPubkey: `position-${start + index}`,
      positionName: "SOL-USDC",
      side: "long",
      action: "Close",
      orderType: "Market",
      price: "100",
      size: "20",
      fee: "0.1",
      pnl: "1",
      createdTime: 1_700_000_000 + start + index,
    }));
    return Response.json({ count: 12, dataList: rows });
  }) as typeof fetch;

  const history = await fetchJupiterPerpsTradeHistory("wallet", { batchSize: 10, maxTrades: 20 });
  assert.deepEqual(starts, [0, 10]);
  assert.equal(history.trades.length, 12);
  assert.equal(history.totalCount, 12);
  assert.equal(history.complete, true);
  assert.equal(history.trades[11]?.pnl, 0.9);
});
