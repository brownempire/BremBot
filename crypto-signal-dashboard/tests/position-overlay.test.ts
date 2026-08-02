import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPositionOverlayGuides,
  projectOverlayGuideNetPnl,
  summarizePositionOverlayPnl,
  validOverlayGuides,
  type PositionOverlayGuide,
} from "../lib/chart/positionOverlay";

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

test("editable TP and SL guides project Jupiter's live post-fee PnL", () => {
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
  assert.equal(tp?.estimatedNetPnlUsd, 0.65);
  assert.equal(tp?.pnlPerPriceUnit, 7.5);
  assert.equal(sl?.estimatedNetPnlUsd, -2.95);
  assert.equal(tp ? projectOverlayGuideNetPnl(tp, 73.1) : null, 1.4);
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
