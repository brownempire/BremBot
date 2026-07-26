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
});

test("Lock Screen and expanded Island show Entry, Mark, TP, and SL", () => {
  for (const label of ["ENTRY", "MARK", "TP", "SL"]) {
    assert.match(widgetSource, new RegExp(`metric\\("${label}"`));
  }
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*Text\(state\.positionLabel\)/);
  assert.match(widgetSource, /\.padding\(\.horizontal, 12\)/);
});

test("expanded Dynamic Island content respects the curved safe edges", () => {
  assert.match(widgetSource, /private var islandBrand[\s\S]*Image\(uiImage: image\)[\s\S]*frame\(width: 64, height: 14/);
  assert.match(widgetSource, /private var islandBrand[\s\S]*Text\("BremLogic"\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.leading\)[\s\S]*islandBrand/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.leading\)[\s\S]*\.contentMargins\(\.leading, 16\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.trailing\)[\s\S]*\.contentMargins\(\.trailing, 16\)/);
  assert.match(widgetSource, /DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*\.padding\(\.horizontal, 12\)/);
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
