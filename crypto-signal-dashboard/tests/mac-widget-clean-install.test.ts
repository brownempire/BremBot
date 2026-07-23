import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("Mac widgets render branded fallback content before the first network refresh", () => {
  const provider = read("ios/App/BremLogicMacWidgetExtension/BremLogicMacWidget.swift");
  const shared = read("ios/App/WidgetShared/BremLogicWidgetShared.swift");

  assert.match(provider, /completion\(BremLogicWidgetStore\.load\(\)\)/);
  assert.match(provider, /refreshSnapshot\(\)/);
  assert.match(provider, /WidgetCenter\.shared\.reloadTimelines/);
  assert.match(provider, /hasCachedSnapshot \? \(hasOpenPerp \? 5 \* 60 : 15 \* 60\) : 30/);
  assert.match(provider, /\.contentShape\(Rectangle\(\)\)\s*\.widgetURL/);
  assert.match(shared, /static func loadCached\(\) -> BremLogicWidgetSnapshot\?/);
  assert.match(shared, /static func beginRefreshIfNeeded/);
  assert.match(shared, /minimumInterval: TimeInterval = 30/);
});
