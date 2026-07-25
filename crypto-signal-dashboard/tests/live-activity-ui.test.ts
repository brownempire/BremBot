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
  assert.match(widgetSource, /\.padding\(\.horizontal, 4\)/);
});

test("Live Activity refresh cadence shares the open-position widget interval", () => {
  assert.match(sharedSource, /BremLogicOpenPositionRefreshInterval: TimeInterval = 5 \* 60/);
  assert.match(widgetSource, /hasOpenPerp \? BremLogicOpenPositionRefreshInterval/);
  assert.match(managerSource, /Task\.sleep\([\s\S]*BremLogicOpenPositionRefreshInterval/);
  assert.match(sceneSource, /BremLogicLiveActivityManager\.startScheduledRefresh\(\)/);
});
