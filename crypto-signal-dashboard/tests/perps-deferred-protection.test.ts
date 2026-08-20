import assert from "node:assert/strict";
import test from "node:test";

import {
  assertScalpPreEntryInventoryIsAuthoritative,
  executeDeferredProtectionFailClosed,
} from "../lib/perps/tradingAgent";
import { createScalpProtectionSubmissionUncertainError } from "../lib/perps/scalpProtectionRecovery";

test("an empty unverified pre-entry inventory blocks live scalp submission", () => {
  assert.throws(() => assertScalpPreEntryInventoryIsAuthoritative({
    positions: [],
    pendingTriggers: [],
    recentTrades: [],
    readEvidence: {
      liveApiSucceeded: true,
      rpcSucceeded: false,
      authoritativePositionAbsence: false,
    },
  }), /not confirmed.*RPC scan/i);
  assert.doesNotThrow(() => assertScalpPreEntryInventoryIsAuthoritative({
    positions: [],
    pendingTriggers: [],
    recentTrades: [],
    readEvidence: {
      liveApiSucceeded: true,
      rpcSucceeded: true,
      authoritativePositionAbsence: true,
    },
  }));
});

test("an unprotected scalp entry retries the confirmed fill and then submits an emergency full close", async () => {
  let attachAttempts = 0;
  let closePositionPubkey: string | null = null;
  const waits: number[] = [];

  const result = await executeDeferredProtectionFailClosed({
    isScalp: true,
    positionPubkey: "position-1",
    attachProtection: async () => {
      attachAttempts += 1;
      throw new Error("confirmed fill is not ready");
    },
    emergencyClose: async (positionPubkey) => {
      closePositionPubkey = positionPubkey;
      return "emergency-close-tx";
    },
    wait: async (delayMs) => { waits.push(delayMs); },
  });

  assert.equal(attachAttempts, 5);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 6_000]);
  assert.equal(closePositionPubkey, "position-1");
  assert.deepEqual(result, {
    status: "emergency-close-submitted",
    protectionTxid: null,
    emergencyCloseTxid: "emergency-close-tx",
    error: "confirmed fill is not ready",
  });
});

test("successful fill-based scalp protection never submits an emergency close", async () => {
  let attachAttempts = 0;
  let closeCalls = 0;

  const result = await executeDeferredProtectionFailClosed({
    isScalp: true,
    positionPubkey: "position-1",
    attachProtection: async () => {
      attachAttempts += 1;
      if (attachAttempts < 3) throw new Error("waiting for fill");
      return "protection-tx";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "unexpected";
    },
    wait: async () => undefined,
  });

  assert.equal(attachAttempts, 3);
  assert.equal(closeCalls, 0);
  assert.deepEqual(result, {
    status: "protected",
    protectionTxid: "protection-tx",
    error: null,
  });
});

test("an accepted TP/SL with a lost response is never retried or followed by an emergency close", async () => {
  let landedSideEffects = 0;
  let closeCalls = 0;
  let waitCalls = 0;

  const result = await executeDeferredProtectionFailClosed({
    isScalp: true,
    positionPubkey: "position-1",
    attachProtection: async () => {
      landedSideEffects += 1;
      throw createScalpProtectionSubmissionUncertainError(new Error("response lost after acceptance"));
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "must-not-close";
    },
    wait: async () => { waitCalls += 1; },
  });

  assert.equal(landedSideEffects, 1);
  assert.equal(closeCalls, 0);
  assert.equal(waitCalls, 0);
  assert.equal(result.status, "recovery-pending");
  assert.match(result.error, /inspect live triggers before any retry or emergency close/i);
});

test("a position discovered during retries is used for fail-closed emergency recovery", async () => {
  let discoveredPosition: string | null = null;
  let attachAttempts = 0;
  let closePosition: string | null = null;

  const result = await executeDeferredProtectionFailClosed({
    isScalp: true,
    positionPubkey: null,
    getPositionPubkey: () => discoveredPosition,
    attachProtection: async () => {
      attachAttempts += 1;
      if (attachAttempts === 2) discoveredPosition = "late-position-pubkey";
      throw new Error("protection API unavailable");
    },
    emergencyClose: async (positionPubkey) => {
      closePosition = positionPubkey;
      return "late-emergency-close-tx";
    },
    wait: async () => undefined,
  });

  assert.equal(attachAttempts, 5);
  assert.equal(closePosition, "late-position-pubkey");
  assert.equal(result.status, "emergency-close-submitted");
});

test("a crossed fill-based trigger closes immediately without wasting protection retries", async () => {
  let attachAttempts = 0;
  let closeCalls = 0;
  let waitCalls = 0;
  const crossed = Object.assign(new Error("take profit already crossed"), {
    code: "LIVE_POSITION_TRIGGER_ALREADY_CROSSED",
  });

  const result = await executeDeferredProtectionFailClosed({
    isScalp: true,
    positionPubkey: "position-1",
    attachProtection: async () => {
      attachAttempts += 1;
      throw crossed;
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "capture-profit-close-tx";
    },
    wait: async () => { waitCalls += 1; },
  });

  assert.equal(attachAttempts, 1);
  assert.equal(waitCalls, 0);
  assert.equal(closeCalls, 1);
  assert.equal(result.status, "emergency-close-submitted");
});

test("standard deferred protection preserves the prior non-scalp behavior", async () => {
  let attachAttempts = 0;
  let closeCalls = 0;

  const result = await executeDeferredProtectionFailClosed({
    isScalp: false,
    positionPubkey: "position-1",
    attachProtection: async () => {
      attachAttempts += 1;
      throw new Error("temporary protection error");
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "unexpected";
    },
    wait: async () => undefined,
  });

  assert.equal(attachAttempts, 3);
  assert.equal(closeCalls, 0);
  assert.deepEqual(result, {
    status: "failed",
    protectionTxid: null,
    error: "temporary protection error",
  });
});
