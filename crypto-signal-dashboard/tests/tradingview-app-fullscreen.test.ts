import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("TradingView uses app-controlled fullscreen instead of the browser fullscreen API", () => {
  const chart = read("app/components/TradingViewChart.tsx");

  assert.match(chart, /"header_fullscreen_button"/);
  assert.match(chart, /setIsAppFullscreen/);
  assert.match(chart, /tradingview-frame--app-fullscreen/);
  assert.match(chart, /Close chart fullscreen/);
  assert.doesNotMatch(chart, /requestFullscreen|webkitRequestFullscreen/);
});

test("app fullscreen covers the viewport with a dark surface and a dedicated close control", () => {
  const css = read("app/globals.css");

  assert.match(
    css,
    /\.tradingview-frame--app-fullscreen\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*width:\s*100vw;[^}]*height:\s*100dvh;/s
  );
  assert.match(
    css,
    /\.tradingview-frame--app-fullscreen\s*\{[^}]*background:\s*#07111f;/s
  );
  assert.match(css, /\.tradingview-fullscreen-button\.is-close/);
  assert.match(css, /body\.chart-app-fullscreen/);
  assert.match(
    css,
    /body\.chart-app-fullscreen \.panel\s*\{[^}]*backdrop-filter:\s*none;/s
  );
  assert.match(
    css,
    /body\.chart-app-fullscreen \.tradingview-wrap\s*\{[^}]*overflow:\s*visible;/s
  );
  assert.match(
    css,
    /body\.chart-app-fullscreen \.bottom-tabs\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s
  );
});
