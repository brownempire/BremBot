import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildLiveActivityApnsRequest,
  buildLiveActivityContentState,
  LIVE_ACTIVITY_CHART_CANDLE_LIMIT,
  liveActivityPositionKey,
} from "../lib/push/liveActivitySender";
import {
  isValidLiveActivityPositionKey,
  isValidLiveActivityToken,
} from "../lib/push/liveActivityStore";
import type { WidgetServerSnapshot } from "../lib/widget/serverSnapshot";

const snapshot: WidgetServerSnapshot = {
  title: "BremLogic",
  openPerpLabel: "SOL SHORT",
  openPerpDetail: "Live Jupiter Perps position",
  openPerpPnlUsd: 4.25,
  openPerpPnlPercent: 21.25,
  openPerpMarket: "SOL",
  openPerpSide: "short",
  openPerpStrategy: "scalp",
  openPerpPositionValueUsd: 200,
  openPerpCollateralUsd: 20,
  openPerpEntryPrice: 75.12,
  openPerpEntryTimestamp: 1_785_000_018,
  openPerpMarkPrice: 74.68,
  openPerpLeverage: 10,
  openPerpLiquidationPrice: 80,
  openPerpTakeProfitPrice: 73.5,
  openPerpStopLossPrice: 76.4,
  openPerpTakeProfitPnlUsd: 5,
  openPerpStopLossPnlUsd: -4,
  chartSymbol: "SOL",
  chartCandles: Array.from({ length: 72 }, (_, index) => ({
    timestamp: 1_784_999_000 + index * 60,
    open: 75 + index * 0.01,
    high: 75.05 + index * 0.01,
    low: 74.95 + index * 0.01,
    close: 75.02 + index * 0.01,
  })),
  walletBalanceUsd: 30,
  mainWalletBalanceUsd: 100,
  agentWalletBalanceUsd: 30,
  perpsAutoTradeStatus: "Agent monitoring is active",
  perpsSessionState: "Clocked In",
  perpsMode: "Live mode",
  perpsExecutionModel: "agent",
  updatedAt: 1_785_000_000,
  targetURL: "bremlogic://open?target=%2Fsignals-bot%3Ftab%3Dperps",
};

test("Live Activity state uses the actual position entry and protection prices", () => {
  const state = buildLiveActivityContentState(snapshot);
  assert.equal(liveActivityPositionKey(snapshot), "SOL-SHORT");
  assert.equal(state.positionLabel, "SOL SHORT");
  assert.equal(state.strategy, "SCALP");
  assert.equal(state.entryPrice, 75.12);
  assert.equal(state.entryTimestamp, 1_785_000_018);
  assert.equal(state.markPrice, 74.68);
  assert.equal(state.takeProfitPrice, 73.5);
  assert.equal(state.stopLossPrice, 76.4);
  assert.equal(state.pnlUsd, 4.25);
  assert.equal(state.chartCandles.length, LIVE_ACTIVITY_CHART_CANDLE_LIMIT);
  assert.deepEqual(state.chartCandles[0], [
    snapshot.chartCandles[12]?.timestamp,
    snapshot.chartCandles[12]?.open,
    snapshot.chartCandles[12]?.high,
    snapshot.chartCandles[12]?.low,
    snapshot.chartCandles[12]?.close,
  ]);
});

test("Live Activity APNs update has the required topic, timing, and content state", () => {
  const state = buildLiveActivityContentState(snapshot);
  const now = Date.parse("2026-07-25T17:00:00.000Z");
  const request = buildLiveActivityApnsRequest({
    token: "a".repeat(64),
    positionKey: "SOL-SHORT",
    state,
    event: "update",
    now,
  });

  assert.equal(request.headers["apns-push-type"], "liveactivity");
  assert.equal(request.headers["apns-priority"], "10");
  assert.equal(
    request.headers["apns-topic"],
    "com.bremlogic.signalsbot.push-type.liveactivity"
  );
  assert.equal(request.body.aps.timestamp, now / 1_000);
  assert.equal(request.body.aps["stale-date"], now / 1_000 + 6 * 60);
  assert.deepEqual(request.body.aps["content-state"], state);
  assert.equal(request.body.aps.event, "update");
  assert.ok(
    Buffer.byteLength(JSON.stringify(request.body), "utf8") < 4_096,
    "Live Activity APNs payload must remain below Apple's 4 KB limit"
  );
});

test("Live Activity end payload dismisses an obsolete position", () => {
  const request = buildLiveActivityApnsRequest({
    token: "b".repeat(64),
    positionKey: "SOL-LONG",
    state: buildLiveActivityContentState(snapshot),
    event: "end",
    now: 1_785_000_000_000,
  });

  assert.equal(request.body.aps.event, "end");
  assert.equal(request.body.aps["dismissal-date"], 1_785_000_000);
});

test("Live Activity registration rejects malformed device tokens and position keys", () => {
  assert.equal(isValidLiveActivityToken("c".repeat(64)), true);
  assert.equal(isValidLiveActivityToken("not-a-token"), false);
  assert.equal(isValidLiveActivityPositionKey("SOL-SHORT"), true);
  assert.equal(isValidLiveActivityPositionKey("../../secret"), false);
});

test("server cron dispatches registered Live Activities on one five-minute window", () => {
  const watchSource = fs.readFileSync(
    path.join(process.cwd(), "lib/push/liveActivityWatch.ts"),
    "utf8"
  );
  const cronSource = fs.readFileSync(
    path.join(process.cwd(), "app/api/perps/automation/run/route.ts"),
    "utf8"
  );
  const registrationSource = fs.readFileSync(
    path.join(process.cwd(), "app/api/push/live-activity/subscribe/route.ts"),
    "utf8"
  );

  assert.match(watchSource, /LIVE_ACTIVITY_REFRESH_INTERVAL_MS = 5 \* 60_000/);
  assert.match(watchSource, /claimLiveActivityDispatchWindow/);
  assert.match(watchSource, /sendLiveActivityApnsUpdates/);
  assert.match(cronSource, /runLiveActivityUpdateWatch\(\)/);
  assert.match(registrationSource, /addLiveActivityPushToken\(\{ token, positionKey \}\)/);
});
