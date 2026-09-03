import assert from "node:assert/strict";
import test from "node:test";

import { fetchJupiterPerpsTradeHistory, type JupiterPerpsPosition, type JupiterPerpsTrade } from "../lib/jupiterPerps";
import { buildPerpsPnlSummary, calculatePnlSince } from "../lib/perps/pnl";
import { panPnlChartDomain, pnlPointsForRange, zoomPnlChartDomain } from "../lib/perps/pnlChart";

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
    pnlAccounting: {
      version: 1, episodeId: overrides.id ?? "episode", status: overrides.action === "Increase" ? "included" : "reconciled",
      netPnlUsd: overrides.pnl ?? 0, netRoePercent: null, capitalUsd: 20, asOf: 1,
    },
    ...overrides,
  };
}

test("Perps PnL combines reconciled closed episodes and estimated open net without double counting entry fees", () => {
  const trades = [
    trade({ id: "entry", action: "Increase", pnl: null, feeUsd: 0.25, createdAt: 1_000 }),
    trade({ id: "win", pnl: 12.5, feeUsd: 0.5, createdAt: 2_000 }),
    trade({ id: "loss", pnl: -3, feeUsd: 0.4, createdAt: 3_000 }),
  ];
  const positions = [{ source: "live-api", unrealizedPnl: 4.75, positionValue: 100, collateralValue: 20 }] as JupiterPerpsPosition[];
  const summary = buildPerpsPnlSummary(trades, positions, 4_000);

  assert.equal(summary.realizedPnlUsd, 9.5);
  assert.equal(summary.unrealizedPnlUsd, 4.59);
  assert.equal(summary.totalPnlUsd, 14.09);
  assert.deepEqual(summary.points.map((point) => point.v), [12.5, 9.5, 14.09]);
  assert.equal(summary.points[0]?.trade?.action, "Close");
  assert.equal(summary.points[0]?.trade?.pnlUsd, 12.5);
  assert.equal(summary.points[1]?.trade?.cumulativePnlUsd, 9.5);
  assert.equal(summary.points[2]?.trade, undefined);
  assert.equal(new Set(summary.points.flatMap((point) => point.trade?.id ?? [])).size, 2);
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

test("PnL chart range keeps every uniquely identified trade plus range boundaries", () => {
  const summary = buildPerpsPnlSummary([
    trade({ id: "before", txHash: "tx-before", createdAt: 500, pnl: 2 }),
    trade({ id: "first", txHash: "tx-first", createdAt: 1_500, pnl: 3 }),
    trade({ id: "second", txHash: "tx-second", createdAt: 2_500, pnl: -1 }),
  ], [], 3_000);

  const ranged = pnlPointsForRange(summary.points, 1_000, 3_000);
  assert.deepEqual(ranged.filter((point) => point.trade).map((point) => point.trade?.id), [
    "tx-first:position:Close:1500",
    "tx-second:position:Close:2500",
  ]);
  assert.deepEqual(ranged.map((point) => point.t), [1_000, 1_500, 2_500, 3_000]);
  assert.equal(ranged[0]?.v, 2);
});

test("PnL chart zoom and horizontal pan remain inside the selected timeframe", () => {
  const bounds = { start: 0, end: 1_000_000 };
  const zoomed = zoomPnlChartDomain(bounds, bounds, 0.5, 0.5);
  assert.deepEqual(zoomed, { start: 250_000, end: 750_000 });

  assert.deepEqual(panPnlChartDomain(zoomed, bounds, 0.25), {
    start: 375_000,
    end: 875_000,
  });
  assert.deepEqual(panPnlChartDomain(zoomed, bounds, 2), {
    start: 500_000,
    end: 1_000_000,
  });
  assert.deepEqual(panPnlChartDomain(zoomed, bounds, -2), {
    start: 0,
    end: 500_000,
  });
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
