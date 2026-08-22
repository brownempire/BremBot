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

test("position refreshes never change TradingView auto scale or the visible price range", () => {
  const chart = read("app/components/TradingViewChart.tsx");

  assert.match(chart, /syncPositionShapes/);
  assert.match(chart, /createShape/);
  assert.doesNotMatch(chart, /setAutoScale/);
  assert.doesNotMatch(chart, /setVisiblePriceRange/);
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

test("the live unrealized PnL remains in the chart toolbar in regular and app fullscreen layouts", () => {
  const chart = read("app/components/TradingViewChart.tsx");
  const page = read("app/signals-bot/page.tsx");
  const css = read("app/globals.css");

  assert.match(chart, /data-testid="tradingview-toolbar-pnl"/);
  assert.match(chart, /Unrealized PnL/);
  assert.match(chart, /signedUsd\(unrealizedPnlUsd\)/);
  assert.match(chart, /unrealizedPnlPercent\.toFixed\(2\)/);
  assert.match(page, /unrealizedPnlUsd=\{selectedChartUnrealizedPnl\}/);
  assert.match(page, /unrealizedPnlPercent=\{selectedChartUnrealizedPnlPercent\}/);
  assert.match(css, /\.tradingview-toolbar-pnl\s*\{[^}]*position:\s*absolute;[^}]*top:\s*8px;/s);
  assert.doesNotMatch(css, /\.tradingview-frame--app-fullscreen[^}]*\.tradingview-toolbar-pnl[^}]*display:\s*none/s);
});
