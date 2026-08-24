import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildScalpAgentOverlaySnapshot } from "../lib/chart/scalpAgentOverlay";
import { clampFloatingPanelPosition } from "../lib/chart/floatingPanel";
import {
  DEFAULT_SCALP_LEARNING_PROFILE,
  getScalpLearningProfile,
  scalpProfileAllowsLiveEntries,
} from "../lib/perps/scalpEngine";
import { BASE_INDICATOR_SETTINGS } from "../lib/signal/indicators";
import type { DecisionLearningProfile } from "../lib/decision/learningTypes";

const projectRoot = path.resolve(import.meta.dirname, "..");

function candleWindow() {
  const start = 1_785_600_000_000;
  return Array.from({ length: 80 }, (_, index) => {
    const close = 100 + Math.sin(index / 4) * 0.18;
    return {
      t: start + index * 60_000,
      o: close - 0.02,
      h: close + 0.05,
      l: close - 0.05,
      v: close,
      volume: 100 + (index % 7) * 12,
    };
  });
}

test("scalp chart snapshot uses the live indicator periods and exposes a failed learning gate", () => {
  const profile = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  profile.validation = {
    ...profile.validation,
    passed: false,
    reasons: ["Loss-history validation remained negative."],
  };
  profile.policyRollout = {
    status: "paused",
    startedAt: "2026-08-19T12:00:00.000Z",
    baselineOutcomeCount: 0,
    reviewedOutcomeCount: 10,
    minimumValidationTrades: 10,
    liveTradingAuthorized: false,
    authorization: "operator-approved-live-rollout",
    reason: "Loss-history validation remained negative.",
  };

  const snapshot = buildScalpAgentOverlaySnapshot({
    symbol: "COINBASE:SOLUSD",
    points: candleWindow(),
    profile,
    indicatorSettings: BASE_INDICATOR_SETTINGS,
    scalpModeEnabled: true,
    isActiveAsset: true,
    now: new Date("2026-08-02T12:00:00.000Z"),
  });

  assert.equal(snapshot.timeframe, "1");
  assert.equal(snapshot.state, "blocked");
  assert.equal(snapshot.profilePassed, false);
  assert.match(snapshot.headline, /validation paused/i);
  assert.match(snapshot.reasons[0] ?? "", /loss-history validation/i);
  assert.equal(snapshot.thresholds.longRsiMaximum, profile.longRsiMaximum);
  assert.equal(snapshot.thresholds.maximumAdx, profile.maximumAdx);
  assert.equal(snapshot.thresholds.exceptionalReversalBypassEnabled, true);
  assert.equal(snapshot.thresholds.minimumContinuationPriceActionScore, 0.64);
  assert.equal(snapshot.thresholds.continuationLongBollingerMaximum, 0.72);
  assert.equal(snapshot.thresholds.continuationShortBollingerMinimum, 0.28);
  assert.equal(snapshot.thresholds.maximum145mNetOrRangePercent, 2);
  assert.ok(snapshot.indicators.emaFast !== null);
  assert.ok(snapshot.indicators.rsi !== null);
  assert.ok(snapshot.indicators.adx !== null);
  assert.ok(snapshot.indicators.bollingerPosition !== null);
});

test("a stale scalp policy remains visibly blocked until winner-baseline migration", () => {
  const stale = structuredClone(DEFAULT_SCALP_LEARNING_PROFILE);
  stale.policyVersion = 2;
  const profile = { scalpProfile: stale } as DecisionLearningProfile;
  const resolved = getScalpLearningProfile(profile);

  assert.equal(resolved.policyVersion, 2);
  assert.equal(scalpProfileAllowsLiveEntries(resolved), false);
});

test("floating scalp setup panel remains inside the chart after dragging or resizing", () => {
  assert.deepEqual(clampFloatingPanelPosition({
    left: -30,
    top: 900,
    panelWidth: 220,
    panelHeight: 80,
    containerWidth: 390,
    containerHeight: 600,
  }), { left: 4, top: 516 });

  assert.deepEqual(clampFloatingPanelPosition({
    left: 120,
    top: 75,
    panelWidth: 220,
    panelHeight: 80,
    containerWidth: 390,
    containerHeight: 600,
  }), { left: 120, top: 75 });
});

test("TradingView overlay installs and removes studies in place without rebuilding the chart", () => {
  const chart = readFileSync(path.join(projectRoot, "app/components/TradingViewChart.tsx"), "utf8");
  const page = readFileSync(path.join(projectRoot, "app/signals-bot/page.tsx"), "utf8");
  const route = readFileSync(path.join(projectRoot, "app/api/perps/scalp-overlay/route.ts"), "utf8");
  const overlay = readFileSync(path.join(projectRoot, "lib/chart/scalpAgentOverlay.ts"), "utf8");

  assert.match(page, /Scalp Agent <strong>\{scalpOverlayEnabled \? "On" : "Off"\}/);
  assert.match(chart, /scalpStudyIdsRef/);
  assert.match(chart, /chart\.setResolution\?\.\("1"\)/);
  assert.match(chart, /safelyRemoveEntity/);
  assert.match(chart, /chart\.getPanes\?\.\(\)/);
  assert.match(chart, /pane\.setHeight\?\.\(92\)/);
  assert.match(chart, /pane\.collapse\?\.\(\)/);
  assert.match(chart, /pane\.restore\?\.\(\)/);
  assert.match(chart, /"pane_context_menu"/);
  assert.match(chart, /Collapse indicators/);
  assert.match(chart, /\}, \[containerId, symbol\]\);/);
  assert.doesNotMatch(chart, /\[containerId, scalpOverlayEnabled, symbol\]/);
  assert.match(chart, /Moving Average Exponential/);
  assert.match(chart, /Bollinger Bands/);
  assert.match(chart, /Relative Strength Index/);
  assert.match(chart, /Directional Movement/);
  assert.match(chart, /\["Volume"\]/);
  assert.match(chart, /shape: bullish \? "arrow_up" : "arrow_down"/);
  assert.match(chart, /data-testid="scalp-chart-status"/);
  assert.match(chart, /data-minimized=\{scalpPanelMinimized \? "true" : "false"\}/);
  assert.match(chart, /onPointerDown=\{beginScalpPanelDrag\}/);
  assert.match(chart, /aria-label=\{scalpPanelMinimized \? "Maximize scalp setup window" : "Minimize scalp setup window"\}/);
  assert.match(chart, /scalpPanelMinimized \? "Waiting"/);
  assert.match(route, /fetchCoinbaseMinuteCandles\(market\.product, 240\)/);
  assert.match(overlay, /Math\.max\(SCALP_EXHAUSTION_LOOKBACK_MINUTES - 1, points\.length - 120\)/);
  assert.match(route, /profile\?\.indicatorSettings/);
  assert.match(route, /listTradeLearningOutcomes\(walletAddress\)/);
  assert.match(route, /recentClosedTrade: latestClosed/);
  assert.doesNotMatch(route, /LAST_SIGNAL_KEY/);
});

test("native widget navigation keeps the mounted chart and provides a contained loading recovery", () => {
  const nativeShell = readFileSync(path.join(projectRoot, "app/components/NativeShellConfigurator.tsx"), "utf8");
  const chart = readFileSync(path.join(projectRoot, "app/components/TradingViewChart.tsx"), "utf8");
  const boundary = readFileSync(path.join(projectRoot, "app/components/ChartErrorBoundary.tsx"), "utf8");
  const page = readFileSync(path.join(projectRoot, "app/signals-bot/page.tsx"), "utf8");

  assert.match(nativeShell, /targetUrl\.pathname === window\.location\.pathname/);
  assert.match(nativeShell, /window\.history\.replaceState/);
  assert.match(nativeShell, /window\.dispatchEvent\(new Event\("popstate"\)\)/);
  assert.match(chart, /isChartLoading/);
  assert.match(chart, /aria-label="Loading TradingView chart"/);
  assert.match(chart, /safelyRemoveWidget/);
  assert.match(boundary, /Reconnecting chart/);
  assert.match(page, /<ChartErrorBoundary>/);
});
