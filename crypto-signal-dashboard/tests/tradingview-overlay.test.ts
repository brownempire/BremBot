import assert from "node:assert/strict";
import test from "node:test";

import { getNativeGuideDrawing, OVERLAY_REFRESH_MS } from "../app/components/TradingViewChart";

test("visible chart overlays reconcile every five seconds", () => {
  assert.equal(OVERLAY_REFRESH_MS, 5_000);
});

test("entry overlays are anchored to their exact TradingView price", () => {
  const drawing = getNativeGuideDrawing({
    id: "entry",
    label: "Entry",
    price: 77.49,
    tone: "entry",
  });

  assert.deepEqual(drawing.point, { price: 77.49 });
  assert.equal(drawing.options.shape, "horizontal_line");
  assert.equal(drawing.options.disableSave, true);
  assert.equal(drawing.options.lock, true);
  assert.equal(drawing.options.overrides.showPrice, true);
});
