import assert from "node:assert/strict";
import test from "node:test";

import { buildApnsRequest } from "../lib/push/apnsSender";

test("iOS APNs alert keeps its custom sound when the app is not running", () => {
  const request = buildApnsRequest(
    { token: "ios-token", platform: "ios" },
    {
      title: "TP Hit · Smart SOL Long",
      body: "Exit $110.00 · P&L +$19.75",
      url: "/signals-bot?tab=perps",
      sound: "brem_tp.wav",
    },
    Date.parse("2026-07-24T12:00:00.000Z")
  );

  assert.equal(request.headers["apns-push-type"], "alert");
  assert.equal(request.headers["apns-priority"], "10");
  assert.equal(request.headers["apns-topic"], "com.bremlogic.signalsbot");
  assert.equal(
    request.headers["apns-expiration"],
    String(Date.parse("2026-07-25T12:00:00.000Z") / 1000)
  );
  assert.equal(request.body.aps.sound, "brem_tp.wav");
  assert.equal(request.body.aps["thread-id"], "bremlogic-trading");
  assert.equal(request.body.url, "/signals-bot?tab=perps");
});

test("APNs alerts use the configured iOS topic and default sound fallback", () => {
  const request = buildApnsRequest(
    { token: "ios-token", platform: "ios" },
    {
      title: "Signal: SOL/USD",
      body: "Breakout detected",
    }
  );

  assert.equal(request.headers["apns-topic"], "com.bremlogic.signalsbot");
  assert.equal(request.body.aps.sound, "default");
  assert.equal(request.body.url, "/signals-bot");
});
