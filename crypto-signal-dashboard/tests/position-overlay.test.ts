import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPositionOverlayScale,
  positionOverlayGuides,
  type PositionOverlayGuide,
} from "../lib/chart/positionOverlay";

const now = Date.now();
const points = Array.from({ length: 60 }, (_, index) => ({
  t: now - (59 - index) * 60_000,
  v: 98 + index * (4 / 59),
}));
const guides: PositionOverlayGuide[] = [
  { id: "entry", label: "Entry", price: 100, tone: "entry" },
  { id: "tp", label: "TP", price: 101, tone: "tp" },
  { id: "sl", label: "SL", price: 99, tone: "sl" },
  { id: "liquidation", label: "Liq", price: 102, tone: "liquidation" },
];

test("position overlay maps higher prices above lower prices", () => {
  const scale = buildPositionOverlayScale({ frameHeight: 520, pricePoints: points, guides, interval: "1" });
  assert.ok(scale);
  const positioned = positionOverlayGuides(guides, scale, 520);
  const byId = Object.fromEntries(positioned.map((guide) => [guide.id, guide]));

  assert.ok(byId.tp.top < byId.entry.top);
  assert.ok(byId.entry.top < byId.sl.top);
  assert.equal(byId.entry.edge, null);
});

test("position overlay keeps out-of-range levels visible at labeled edges", () => {
  const distantGuides: PositionOverlayGuide[] = [
    { id: "high", label: "TP", price: 150, tone: "tp" },
    { id: "low", label: "SL", price: 50, tone: "sl" },
  ];
  const scale = buildPositionOverlayScale({
    frameHeight: 520,
    pricePoints: points,
    guides: distantGuides,
    interval: "1",
  });
  assert.ok(scale);
  const positioned = positionOverlayGuides(distantGuides, scale, 520);

  assert.equal(positioned.length, 2);
  assert.equal(positioned[0].edge, "above");
  assert.equal(positioned[1].edge, "below");
  positioned.forEach((guide) => assert.ok(guide.top > 0 && guide.top < 100));
});

test("position overlay remains available before candle history loads", () => {
  const scale = buildPositionOverlayScale({ frameHeight: 520, pricePoints: [], guides, interval: "15" });
  assert.ok(scale);
  assert.equal(positionOverlayGuides(guides, scale, 520).length, guides.length);
});

test("position overlay rejects invalid levels without dropping valid ones", () => {
  const scale = buildPositionOverlayScale({ frameHeight: 520, pricePoints: points, guides, interval: "1" });
  assert.ok(scale);
  const mixed = [...guides, { id: "bad", label: "Bad", price: Number.NaN, tone: "sl" as const }];
  assert.deepEqual(positionOverlayGuides(mixed, scale, 520).map((guide) => guide.id), [
    "entry",
    "tp",
    "sl",
    "liquidation",
  ]);
});
