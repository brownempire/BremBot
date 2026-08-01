import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPositionOverlayGuides,
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
      { id: "position-sol-tp", label: "TP", price: 75.5, tone: "tp" },
      {
        id: "position-sol-liquidation",
        label: "Liq",
        price: 71.5,
        tone: "liquidation",
      },
      { id: "position-sol-sl", label: "SL", price: 72.5, tone: "sl" },
    ]
  );
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
