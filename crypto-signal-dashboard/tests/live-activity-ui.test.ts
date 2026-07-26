import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sharedSource = fs.readFileSync(
  path.join(process.cwd(), "ios/App/WidgetShared/BremLogicWidgetShared.swift"),
  "utf8"
);
const widgetSource = fs.readFileSync(
  path.join(process.cwd(), "ios/App/BremLogicWidgetExtension/BremLogicWidget.swift"),
  "utf8"
);
const managerSource = fs.readFileSync(
  path.join(process.cwd(), "ios/App/App/BremLogicLiveActivityManager.swift"),
  "utf8"
);
const sceneSource = fs.readFileSync(
  path.join(process.cwd(), "ios/App/App/SceneDelegate.swift"),
  "utf8"
);

test("Live Activity state carries the actual open-position entry price", () => {
  assert.match(sharedSource, /var entryPrice: Double\?/);
  assert.match(sharedSource, /entryPrice: snapshot\.openPerpEntryPrice/);
  assert.match(sharedSource, /var chartCandles: \[\[Double\]\]\?/);
  assert.match(sharedSource, /suffix\(60\)/);
  assert.match(widgetSource, /values\.count == 5/);
});

test("Lock Screen and expanded Island charts show Entry, Mark, TP, and SL", () => {
  for (const property of [
    "entryPrice",
    "markPrice",
    "takeProfitPrice",
    "stopLossPrice",
  ]) {
    assert.match(widgetSource, new RegExp(`${property}: state\\.${property}`));
  }
  assert.match(widgetSource, /private func activityChart[\s\S]*BremLogicCandlestickChart/);
  assert.match(widgetSource, /lockScreenView[\s\S]*activityChart\(state\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*Text\(state\.positionLabel\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*activityChart\(state\)/);
  assert.match(widgetSource, /\.padding\(\.horizontal, 12\)/);
});

test("Live Activity presentations consume the 160-point allowance without overflow", () => {
  assert.match(widgetSource, /private let liveActivityMaximumHeight: CGFloat = 160/);
  assert.match(widgetSource, /lockScreenView[\s\S]*\.frame\(height: liveActivityMaximumHeight\)[\s\S]*\.clipped\(\)/);
  assert.match(widgetSource, /private let expandedIslandBottomHeight: CGFloat = 120/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*\.frame\(height: expandedIslandBottomHeight\)[\s\S]*\.clipped\(\)/);
});

test("expanded Dynamic Island content respects the curved safe edges", () => {
  assert.match(widgetSource, /private var islandBrand[\s\S]*Image\(uiImage: image\)[\s\S]*frame\(width: 68, height: 17/);
  assert.match(widgetSource, /private var islandBrand[\s\S]*Text\("BremLogic"\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.leading\)[\s\S]*islandBrand/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.leading\)[\s\S]*\.contentMargins\(\.leading, 27\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.trailing\)[\s\S]*\.frame\(maxWidth: \.infinity, alignment: \.trailing\)[\s\S]*\.padding\(\.trailing, 12\)[\s\S]*\.contentMargins\(\.trailing, 27\)/);
  assert.match(widgetSource, /Text\(signedUsd\(state\.pnlUsd\)\)[\s\S]*\.monospacedDigit\(\)[\s\S]*Text\(percent\(state\.pnlPercent\)\)[\s\S]*\.monospacedDigit\(\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*\.padding\(\.horizontal, 12\)/);
});

test("Lock Screen Live Activity uses the logo and keeps strategy beside the position", () => {
  assert.match(widgetSource, /private var activityBrand[\s\S]*Image\(uiImage: image\)[\s\S]*frame\(width: 82, height: 22/);
  assert.doesNotMatch(widgetSource, /Text\("BREMLOGIC •/);
  assert.match(widgetSource, /HStack\(alignment: \.firstTextBaseline, spacing: 8\)[\s\S]*Text\(state\.positionLabel\)[\s\S]*Text\(strategyLabel\(state\.strategy\)\)/);
  assert.match(widgetSource, /private func strategyLabel\(_ value: String\) -> String \{\s*value\.uppercased\(\)\s*\}/);
});

test("Live Activity refresh cadence shares the open-position widget interval", () => {
  assert.match(sharedSource, /BremLogicOpenPositionRefreshInterval: TimeInterval = 5 \* 60/);
  assert.match(widgetSource, /hasOpenPerp \? BremLogicOpenPositionRefreshInterval/);
  assert.match(managerSource, /Task\.sleep\([\s\S]*BremLogicOpenPositionRefreshInterval/);
  assert.match(sceneSource, /BremLogicLiveActivityManager\.startScheduledRefresh\(\)/);
});

test("iPhone Live Activities request and register ActivityKit push tokens", () => {
  assert.match(sharedSource, /api\/push\/live-activity\/subscribe/);
  assert.match(managerSource, /pushType: \.token/);
  assert.match(managerSource, /activity\.pushTokenUpdates/);
  assert.match(managerSource, /"positionKey": positionKey/);
  assert.match(managerSource, /URLSession\.shared\.data\(for: request\)/);
});

test("free Apple signing falls back to a local-only Live Activity", () => {
  assert.match(managerSource, /private var localOnlyActivityIDs: Set<String>/);
  assert.match(managerSource, /pushType: \.token[\s\S]*catch \{[\s\S]*pushType: nil/);
  assert.match(managerSource, /localOnlyActivityIDs\.insert\(localActivity\.id\)/);
  assert.match(managerSource, /!localOnlyActivityIDs\.contains\(matchingActivity\.id\)/);
});
