import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPositionEntryMarkers,
  buildPositionOverlayGuides,
  estimatePositionNetExitPnl,
  projectOverlayGuideNetPnl,
  summarizePositionOverlayEstimatedNetPnl,
  summarizePositionOverlayEstimatedNetPnlPercent,
  summarizePositionOverlayPnl,
  summarizePositionOverlayPnlPercent,
  validOverlayGuides,
  type PositionOverlayGuide,
} from "../lib/chart/positionOverlay";

test("chart PnL reserves realistic remaining costs without double-counting Jupiter's open fee", () => {
  const live = {
    id: "live",
    collateralValue: 20,
    entryPrice: 100,
    liquidationPrice: null,
    positionValue: 500,
    source: "live-api",
    stopLoss: null,
    takeProfit: null,
    unrealizedPnl: 2,
  };
  const rpc = { ...live, id: "rpc", source: "rpc-direct" };

  assert.deepEqual(estimatePositionNetExitPnl(live), {
    estimatedExitCostsUsd: 0.74,
    estimatedNetPnlUsd: 1.26,
  });
  assert.equal(estimatePositionNetExitPnl(rpc), null);
  assert.equal(summarizePositionOverlayEstimatedNetPnl([live]), 1.26);
  assert.equal(summarizePositionOverlayEstimatedNetPnlPercent([live]), 6.3);
});

test("entry markers bind to the current open episode and persist at its original candle", () => {
  const positions = [{
    id: "position-sol",
    accountRef: "position-pubkey",
    entryPrice: 93.81,
    marketSymbol: "SOL",
    side: "long" as const,
    takeProfit: null,
    stopLoss: null,
    liquidationPrice: null,
  }];
  const markers = buildPositionEntryMarkers({
    positions,
    trades: [
      { action: "Increase", createdAt: 1_780_000_000_000, positionPubkey: "position-pubkey", side: "long" },
      { action: "Close", createdAt: 1_780_000_600_000, positionPubkey: "position-pubkey", side: "long" },
      { action: "Increase", createdAt: 1_780_001_200_000, positionPubkey: "position-pubkey", side: "long" },
    ],
  });

  assert.deepEqual(markers, [{
    id: "position-sol:entry:1780001200",
    label: "Entry",
    positionId: "position-sol",
    price: 93.81,
    side: "long",
    time: 1_780_001_200,
  }]);
  assert.deepEqual(buildPositionEntryMarkers({ positions: [] }), []);
});

test("entry markers fall back to the latest active matching execution", () => {
  const markers = buildPositionEntryMarkers({
    positions: [{
      id: "position-sol",
      accountRef: "position-pubkey",
      entryPrice: 74.2,
      marketSymbol: "SOL",
      side: "short",
      takeProfit: null,
      stopLoss: null,
      liquidationPrice: null,
    }],
    executions: [
      { createdAt: "2026-08-22T12:00:00.000Z", positionPubkey: "position-pubkey", side: "short", status: "closed" },
      { createdAt: "2026-08-23T14:15:30.000Z", positionPubkey: "position-pubkey", side: "short", status: "confirmed" },
    ],
  });

  assert.equal(markers[0]?.time, Date.parse("2026-08-23T14:15:30.000Z") / 1_000);
  assert.equal(markers[0]?.price, 74.2);
});

test("chart overlay PnL summarizes the same visible positions", () => {
  assert.equal(summarizePositionOverlayPnl([]), null);
  assert.equal(summarizePositionOverlayPnl([
    { id: "one", entryPrice: 1, takeProfit: 2, stopLoss: null, liquidationPrice: null, unrealizedPnl: 1.26 },
    { id: "two", entryPrice: 1, takeProfit: 2, stopLoss: null, liquidationPrice: null, unrealizedPnl: -0.5 },
  ]), 0.76);
  assert.equal(summarizePositionOverlayPnl([
    { id: "pending", entryPrice: 1, takeProfit: null, stopLoss: null, liquidationPrice: null, unrealizedPnl: null },
  ]), null);
});

test("chart overlay PnL percent uses combined collateral and requires complete live values", () => {
  assert.equal(summarizePositionOverlayPnlPercent([]), null);
  assert.equal(summarizePositionOverlayPnlPercent([
    { id: "one", collateralValue: 20, entryPrice: 1, takeProfit: 2, stopLoss: null, liquidationPrice: null, unrealizedPnl: 2 },
    { id: "two", collateralValue: 30, entryPrice: 1, takeProfit: 2, stopLoss: null, liquidationPrice: null, unrealizedPnl: -0.5 },
  ]), 3);
  assert.equal(summarizePositionOverlayPnlPercent([
    { id: "missing", collateralValue: null, entryPrice: 1, takeProfit: null, stopLoss: null, liquidationPrice: null, unrealizedPnl: 1 },
  ]), null);
});

test("live position fields map to all four native Advanced Chart levels", () => {
  assert.deepEqual(
    buildPositionOverlayGuides([
      {
        id: "position-sol",
        entryPrice: 74.1,
        takeProfit: 75.5,
        stopLoss: 72.5,
        liquidationPrice: 71.5,
      },
    ]),
    [
      { id: "position-sol-entry", label: "Entry", price: 74.1, tone: "entry" },
      {
        editable: true,
        estimatedNetPnlUsd: null,
        id: "position-sol-tp",
        kind: "tp",
        label: "TP",
        pnlPerPriceUnit: null,
        positionId: "position-sol",
        price: 75.5,
        tone: "tp",
      },
      {
        id: "position-sol-liquidation",
        label: "Liq",
        price: 71.5,
        tone: "liquidation",
      },
      {
        editable: true,
        estimatedNetPnlUsd: null,
        id: "position-sol-sl",
        kind: "sl",
        label: "SL",
        pnlPerPriceUnit: null,
        positionId: "position-sol",
        price: 72.5,
        tone: "sl",
      },
    ]
  );
});

test("editable TP and SL guides include the same estimated closing reserve as the open label", () => {
  const guides = buildPositionOverlayGuides([{
    id: "position-sol",
    entryPrice: 72.86,
    markPrice: 72.9,
    positionSize: 7.5,
    takeProfit: 73,
    stopLoss: 72.52,
    liquidationPrice: 71,
    side: "long",
    unrealizedPnl: -0.1,
  }]);

  const tp = guides.find((guide) => guide.kind === "tp");
  const sl = guides.find((guide) => guide.kind === "sl");
  assert.equal(tp?.estimatedNetPnlUsd, -0.48);
  assert.equal(tp?.pnlPerPriceUnit, 7.5);
  assert.equal(sl?.estimatedNetPnlUsd, -4.08);
  assert.equal(tp ? projectOverlayGuideNetPnl(tp, 73.1) : null, 0.27);
});

test("multiple live positions receive distinct numbered chart labels", () => {
  const result = buildPositionOverlayGuides([
    {
      id: "position-one",
      entryPrice: 100,
      takeProfit: null,
      stopLoss: null,
      liquidationPrice: 70,
    },
    {
      id: "position-two",
      entryPrice: 102,
      takeProfit: 110,
      stopLoss: 95,
      liquidationPrice: Number.NaN,
    },
  ]);

  assert.deepEqual(
    result.map((guide) => guide.label),
    ["1 Entry", "1 Liq", "2 Entry", "2 TP", "2 SL"]
  );
});

test("invalid position prices never become Advanced Chart drawings", () => {
  const guides: PositionOverlayGuide[] = [
    { id: "entry", label: "Entry", price: 74.1, tone: "entry" },
    { id: "nan", label: "TP", price: Number.NaN, tone: "tp" },
    { id: "zero", label: "SL", price: 0, tone: "sl" },
  ];

  assert.deepEqual(validOverlayGuides(guides).map((guide) => guide.id), ["entry"]);
});
