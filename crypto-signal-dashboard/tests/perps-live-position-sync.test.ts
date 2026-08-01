import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("Perps positions refresh promptly and recover from an authentication request race", () => {
  const hook = read("hooks/useJupiterPerpsPositions.ts");

  assert.match(hook, /LIVE_PERPS_REFRESH_MS = 5_000/);
  assert.match(hook, /activeRequest\.key !== requestKey/);
  assert.match(hook, /latestRequestKeyRef\.current !== requestKey/);
  assert.match(hook, /window\.addEventListener\("focus", refreshWhenForegrounded\)/);
  assert.match(hook, /window\.addEventListener\("pageshow", refreshWhenForegrounded\)/);
  assert.match(hook, /document\.addEventListener\("visibilitychange", refreshWhenForegrounded\)/);
});

test("the hidden Perps panel keeps the shared chart position snapshot current", () => {
  const widget = read("app/components/JupiterPerpsPositionWidget.tsx");
  const page = read("app/signals-bot/page.tsx");

  assert.match(widget, /pollingEnabled: true/);
  assert.doesNotMatch(widget, /IntersectionObserver/);
  assert.match(page, /summarizePositionOverlayPnl\(selectedChartPerpsPositions\)/);
  assert.match(page, /Unrealized PnL/);
  assert.match(page, /selectedChartUnrealizedPnl >= 0[\s\S]*pnl-positive[\s\S]*pnl-negative/);
});
