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

test("Apple position charts mark the execution candle only while it is visible", () => {
  const phoneWidget = read("ios/App/BremLogicWidgetExtension/BremLogicWidget.swift");
  const sharedChart = read("ios/App/WidgetShared/BremLogicWidgetShared.swift");
  const watchChart = read("ios/App/BremLogicWatchApp/BremLogicWatchContentView.swift");
  const watchComplication = read("ios/App/BremLogicWatchWidgetExtension/BremLogicWatchWidget.swift");

  assert.match(sharedChart, /openPerpEntryTimestamp/);
  assert.match(sharedChart, /bremLogicEntryCandleIndex/);
  assert.match(sharedChart, /entryTimestamp >= first\.timestamp/);
  assert.match(sharedChart, /entryTimestamp < last\.timestamp \+ interval/);
  assert.match(sharedChart, /context\.stroke\(marker, with: \.color\(entryColor\), lineWidth: 1\.8\)/);
  assert.match(phoneWidget, /entryTimestamp: entry\.snapshot\.openPerpEntryTimestamp/);
  assert.match(watchChart, /bremLogicWatchEntryCandleIndex/);
  assert.match(watchComplication, /visibleEntryCandleIndex/);
  assert.match(watchComplication, /context\.stroke\(marker, with: \.color\(entryColor\), lineWidth: 1\.25\)/);
});

test("iPhone Lock Screen rectangle and Live Activity expose the requested trade summary", () => {
  const phoneWidget = read("ios/App/BremLogicWidgetExtension/BremLogicWidget.swift");
  const widgetBundle = read("ios/App/BremLogicWidgetExtension/BremLogicWidgetBundle.swift");
  const activityManager = read("ios/App/App/BremLogicLiveActivityManager.swift");
  const infoPlist = read("ios/App/App/Info.plist");

  assert.ok(phoneWidget.includes('Text("\\(positionLabel) • \\(strategyLabel)")'));
  assert.match(phoneWidget, /pnlPercentLabel/);
  assert.match(phoneWidget, /M .*openPerpMarkPrice/);
  assert.match(phoneWidget, /TP .*openPerpTakeProfitPrice/);
  assert.match(phoneWidget, /SL .*openPerpStopLossPrice/);
  assert.match(phoneWidget, /ActivityConfiguration\(for: BremLogicTradeActivityAttributes\.self\)/);
  assert.match(widgetBundle, /BremLogicTradeLiveActivityWidget\(\)/);
  assert.match(activityManager, /Activity<BremLogicTradeActivityAttributes>\.request/);
  assert.match(activityManager, /matchingActivity\.update/);
  assert.match(activityManager, /activity\.end/);
  assert.match(infoPlist, /<key>NSSupportsLiveActivities<\/key>\s*<true\/>/);
});
