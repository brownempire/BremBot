import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath: string) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("normal native app launches open the Signals tab", () => {
  const capacitorConfig = read("capacitor.config.ts");
  const macApp = read("ios/App/BremLogicMacApp/BremLogicMacWebView.swift");
  const dashboard = read("app/signals-bot/page.tsx");

  assert.match(capacitorConfig, /signals-bot\?nativeShell=ios&tab=signals/);
  assert.match(macApp, /homeURL = URL\(string: "https:\/\/app\.bremlogic\.com\/signals-bot\?tab=signals"\)/);
  assert.match(dashboard, /useState<SignalsAppTab>\("signals"\)/);
  assert.match(dashboard, /nextUrl\.searchParams\.set\("tab", "signals"\)/);
});

test("iPhone, iPad, and Mac widgets open the Signals tab", () => {
  const serverSnapshot = read("lib/widget/serverSnapshot.ts");
  const iosWidget = read("ios/App/BremLogicWidgetExtension/BremLogicWidget.swift");
  const macWidget = read("ios/App/BremLogicMacWidgetExtension/BremLogicMacWidget.swift");
  const sharedWidget = read("ios/App/WidgetShared/BremLogicWidgetShared.swift");

  assert.match(serverSnapshot, /targetURL: "bremlogic:\/\/open\?target=%2Fsignals-bot%3Ftab%3Dsignals"/);
  assert.match(sharedWidget, /targetURL: "bremlogic:\/\/open\?target=%2Fsignals-bot%3Ftab%3Dsignals"/);
  assert.match(iosWidget, /https:\/\/app\.bremlogic\.com\/signals-bot\?tab=signals/);
  assert.match(macWidget, /https:\/\/app\.bremlogic\.com\/signals-bot\?tab=signals/);
});
