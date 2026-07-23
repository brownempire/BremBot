import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("Apple position widgets render stop-loss price and expected P/L", () => {
  const watchComplication = read("ios/App/BremLogicWatchWidgetExtension/BremLogicWatchWidget.swift");
  const watchApp = read("ios/App/BremLogicWatchApp/BremLogicWatchContentView.swift");
  const phoneWidget = read("ios/App/BremLogicWidgetExtension/BremLogicWidget.swift");
  const macWidget = read("ios/App/BremLogicMacWidgetExtension/BremLogicMacWidget.swift");
  const sharedChart = read("ios/App/WidgetShared/BremLogicWidgetShared.swift");

  assert.match(watchComplication, /Text\("SL .*openPerpStopLossPrice/);
  for (const source of [watchApp, phoneWidget, macWidget]) {
    assert.match(source, /openPerpStopLossPrice/);
    assert.match(source, /openPerpStopLossPnlUsd/);
  }
  assert.match(sharedChart, /let stopLossPrice: Double\?/);
  assert.match(sharedChart, /legendItem\("SL", stopLossPrice/);
});
