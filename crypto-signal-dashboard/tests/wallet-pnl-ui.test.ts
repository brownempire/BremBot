import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../app/signals-bot/page.tsx", import.meta.url), "utf8");
const chartSource = fs.readFileSync(new URL("../app/components/PerpsPnlChart.tsx", import.meta.url), "utf8");

test("Wallet panel switches between matching Main and Agent balance views", () => {
  assert.match(pageSource, /Main Balance/);
  assert.match(pageSource, /Agent Balance/);
  assert.match(pageSource, /readOnlyPerpsSnapshot\.agentWalletAddress/);
  assert.match(pageSource, /displayedWalletTokens\.map/);
  assert.match(pageSource, /Agent Balance is read only/);
});

test("PnL panel labels the owner wallet Main and renders the interactive trade chart", () => {
  assert.match(pageSource, />Main<\/button>/);
  assert.doesNotMatch(pageSource, />Primary<\/button>/);
  assert.match(pageSource, /<PerpsPnlChart/);
  assert.match(chartSource, /onWheel=\{handleWheel\}/);
  assert.match(chartSource, /onPointerMove=\{handlePointerMove\}/);
  assert.match(chartSource, /setSelectedTrade\(point\.trade/);
  assert.match(chartSource, /role="dialog" aria-label="Selected trade details"/);
});
