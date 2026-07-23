import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("Watch complications request faster open-position and monitoring refreshes", () => {
  const sharedSource = fs.readFileSync(
    path.join(process.cwd(), "ios/App/BremLogicWatchShared/BremLogicWatchSnapshot.swift"),
    "utf8"
  );
  const widgetSource = fs.readFileSync(
    path.join(process.cwd(), "ios/App/BremLogicWatchWidgetExtension/BremLogicWatchWidget.swift"),
    "utf8"
  );

  assert.match(sharedSource, /openPositionInterval: TimeInterval = 30/);
  assert.match(sharedSource, /monitoringInterval: TimeInterval = 2 \* 60/);
  assert.match(widgetSource, /minimumReloadInterval = max\(15, interval \* 0\.8\)/);
  assert.match(widgetSource, /policy: \.after\(Date\(\)\.addingTimeInterval\(refreshInterval\)\)/);
});
