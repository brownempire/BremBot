import http2 from "node:http2";

import {
  createApnsJwt,
  getApnsAuthority,
  getApnsBundleId,
  getApnsConfigError,
} from "@/lib/push/apnsSender";
import {
  removeLiveActivityPushToken,
  type LiveActivityPushTokenRecord,
} from "@/lib/push/liveActivityStore";
import type {
  WidgetChartCandle,
  WidgetServerSnapshot,
} from "@/lib/widget/serverSnapshot";

export const LIVE_ACTIVITY_CHART_CANDLE_LIMIT = 24;

export type LiveActivityContentState = {
  positionLabel: string;
  market: string;
  side: string;
  strategy: string;
  pnlUsd: number | null;
  pnlPercent: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  chartCandles: WidgetChartCandle[];
  updatedAt: number;
  targetURL: string;
};

function upperOrFallback(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim().toUpperCase();
  return normalized || fallback;
}

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function liveActivityChartCandles(candles: WidgetChartCandle[]) {
  return candles
    .filter((candle) => (
      Number.isFinite(candle.timestamp)
      && Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close)
    ))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-LIVE_ACTIVITY_CHART_CANDLE_LIMIT);
}

export function liveActivityPositionKey(snapshot: WidgetServerSnapshot) {
  if (!snapshot.openPerpMarket || !snapshot.openPerpSide) return null;
  return `${upperOrFallback(snapshot.openPerpMarket, "PERPS")}-${upperOrFallback(snapshot.openPerpSide, "OPEN")}`;
}

export function buildLiveActivityContentState(
  snapshot: WidgetServerSnapshot
): LiveActivityContentState {
  const market = upperOrFallback(snapshot.openPerpMarket, "PERPS");
  const side = upperOrFallback(snapshot.openPerpSide, "OPEN");
  return {
    positionLabel: snapshot.openPerpLabel?.trim() || `${market} ${side}`,
    market,
    side,
    strategy: upperOrFallback(snapshot.openPerpStrategy, "PERPS"),
    pnlUsd: finiteOrNull(snapshot.openPerpPnlUsd),
    pnlPercent: finiteOrNull(snapshot.openPerpPnlPercent),
    entryPrice: finiteOrNull(snapshot.openPerpEntryPrice),
    markPrice: finiteOrNull(snapshot.openPerpMarkPrice),
    takeProfitPrice: finiteOrNull(snapshot.openPerpTakeProfitPrice),
    stopLossPrice: finiteOrNull(snapshot.openPerpStopLossPrice),
    chartCandles: liveActivityChartCandles(snapshot.chartCandles),
    updatedAt: finiteOrNull(snapshot.updatedAt) ?? Date.now() / 1_000,
    targetURL: snapshot.targetURL,
  };
}

export function buildLiveActivityApnsRequest(options: {
  token: string;
  positionKey: string;
  state: LiveActivityContentState;
  event: "update" | "end";
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const timestamp = Math.floor(now / 1_000);
  return {
    headers: {
      ":method": "POST",
      ":path": `/3/device/${options.token}`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "apns-topic": `${getApnsBundleId()}.push-type.liveactivity`,
      "apns-expiration": String(timestamp + 10 * 60),
      "apns-collapse-id": `bremlogic-${options.positionKey}`.slice(0, 64),
    },
    body: {
      aps: {
        timestamp,
        event: options.event,
        "content-state": options.state,
        "stale-date": timestamp + 6 * 60,
        ...(options.event === "end" ? { "dismissal-date": timestamp } : {}),
      },
    },
  };
}

export async function sendLiveActivityApnsUpdates(options: {
  records: LiveActivityPushTokenRecord[];
  snapshot: WidgetServerSnapshot;
  now?: number;
}) {
  if (getApnsConfigError()) {
    return {
      sent: 0,
      ended: 0,
      results: options.records.map((record) => ({
        token: record.token,
        event: "update" as const,
        ok: false,
        statusCode: 0,
      })),
    };
  }

  const jwt = createApnsJwt();
  if (!jwt) {
    return { sent: 0, ended: 0, results: [] };
  }

  const activePositionKey = liveActivityPositionKey(options.snapshot);
  const state = buildLiveActivityContentState(options.snapshot);
  const client = http2.connect(getApnsAuthority());

  const results = await Promise.all(options.records.map((record) => (
    new Promise<{
      token: string;
      event: "update" | "end";
      ok: boolean;
      statusCode: number;
    }>((resolve) => {
      const event = activePositionKey === record.positionKey ? "update" : "end";
      const apnsRequest = buildLiveActivityApnsRequest({
        token: record.token,
        positionKey: record.positionKey,
        state,
        event,
        now: options.now,
      });
      const request = client.request({
        ...apnsRequest.headers,
        authorization: `bearer ${jwt}`,
      });

      let statusCode = 0;
      request.on("response", (headers) => {
        statusCode = Number(headers[http2.constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on("data", () => undefined);
      request.on("end", async () => {
        if ((event === "end" && statusCode === 200) || statusCode === 400 || statusCode === 410) {
          await removeLiveActivityPushToken(record.token);
        }
        resolve({ token: record.token, event, ok: statusCode === 200, statusCode });
      });
      request.on("error", () => {
        resolve({ token: record.token, event, ok: false, statusCode: 0 });
      });
      request.end(JSON.stringify(apnsRequest.body));
    })
  )));

  client.close();
  return {
    sent: results.filter((result) => result.ok && result.event === "update").length,
    ended: results.filter((result) => result.ok && result.event === "end").length,
    results,
  };
}
