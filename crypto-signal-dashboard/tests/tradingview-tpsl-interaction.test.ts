import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("TradingView TP/SL drawings stage drag changes behind explicit confirmation", () => {
  const chart = readFileSync(path.join(projectRoot, "app/components/TradingViewChart.tsx"), "utf8");

  assert.match(chart, /subscribe\?\.\("drawing_event"/);
  assert.match(chart, /eventType !== "points_changed"/);
  assert.match(chart, /setUserEditEnabled\?\.\(enabled\)/);
  assert.match(chart, />Modify<\/button>/);
  assert.match(chart, /isSavingGuide \? "Saving…" : "Confirm"/);
  assert.match(chart, />Cancel<\/button>/);
  assert.match(chart, /await onModifyGuide\(guideEditor\.guide, guideEditor\.draftPrice\)/);
  assert.match(chart, /setShapePrice\(guideEditor\.guide\.id, guideEditor\.guide\.price\)/);
});

test("chart TP/SL control presents quick-glance net PnL wording", () => {
  const chart = readFileSync(path.join(projectRoot, "app/components/TradingViewChart.tsx"), "utf8");
  const css = readFileSync(path.join(projectRoot, "app/globals.css"), "utf8");

  assert.match(chart, /Est\. net P&amp;L/);
  assert.match(chart, /data-testid="chart-tpsl-editor"/);
  assert.match(css, /\.chart-tpsl-editor\s*\{/);
});
