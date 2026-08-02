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
  assert.match(shared, /sharedDefaults\.synchronize\(\)/);
  assert.match(shared, /UserDefaults\.standard\.synchronize\(\)/);
});

test("Mac-compatible widgets refresh all timelines and avoid unsupported custom app links", () => {
  const intent = read("ios/App/BremLogicMacWidgetExtension/BremLogicMacWidgetRefreshIntent.swift");
  const iosIntent = read("ios/App/BremLogicWidgetExtension/BremLogicWidgetRefreshIntent.swift");
  const iosWidget = read("ios/App/BremLogicWidgetExtension/BremLogicWidget.swift");

  for (const source of [intent, iosIntent]) {
    assert.match(source, /let snapshot = try await BremLogicWidgetServerClient\.fetch\(\)/);
    assert.match(source, /try BremLogicWidgetStore\.save\(snapshot\)/);
    assert.match(source, /WidgetCenter\.shared\.reloadAllTimelines\(\)/);
  }
  assert.match(iosWidget, /ProcessInfo\.processInfo\.isiOSAppOnMac/);
  assert.match(iosWidget, /https:\/\/app\.bremlogic\.com\/signals-bot\?tab=perps/);
  assert.match(iosWidget, /\.widgetURL\(bremLogicWidgetTargetURL\(entry\.snapshot\.targetURL\)\)/);
});

test("native Mac web view keeps TradingView blob URLs inside WebKit", () => {
  const browser = read("ios/App/BremLogicMacApp/BremLogicMacWebView.swift");

  assert.match(browser, /webViewSchemes: Set<String> = \["about", "blob", "data", "file", "http", "https"\]/);
  assert.match(browser, /if Self\.webViewSchemes\.contains\(scheme\) \{\s*decisionHandler\(\.allow\)/);
  assert.match(browser, /urlForApplication\(toOpen: url\) != nil/);
  assert.match(browser, /loadBremLogicURL\(url\)/);
});
