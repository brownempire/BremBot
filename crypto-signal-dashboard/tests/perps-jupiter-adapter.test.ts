import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";

import {
  assertCompleteJupiterRpcOwnerAccountClassification,
  classifyJupiterRpcOwnerAccounts,
  isAuthoritativeJupiterRpcPositionAbsence,
} from "../lib/jupiterPerps";
import {
  buildEntryWithTpslFallback,
  getInitialPositionTpsl,
  getStandalonePositionTpsl,
  LivePositionTriggerAlreadyCrossedError,
  rebaseTakeProfitForLivePosition,
  rebaseTpslForLivePosition,
} from "../lib/perps/tpslPlan";
import type { PerpsSignalPayload } from "../lib/perps/types";

function signal(): PerpsSignalPayload {
  return {
    signalId: "signal-tpsl",
    strategyId: "test",
    market: "SOL-PERP",
    assetMint: "SOL",
    side: "long",
    action: "open",
    collateralUsd: 11,
    sizeUsd: 847,
    leverage: 77,
    maxSlippageBps: 100,
    takeProfit: { enabled: true, priceUsd: 77.25 },
    stopLoss: { enabled: true, priceUsd: 75.5 },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reason: "Test TP/SL",
    walletAddress: "AgentWallet11111111111111111111111111111111",
    source: "ui-local",
  };
}

const CURRENT_POSITION_DISCRIMINATOR = Buffer.from("aabc8fe47a40f7d0", "hex");
const RPC_OWNER = new PublicKey(new Uint8Array(32).fill(1));
const RPC_POOL = new PublicKey(new Uint8Array(32).fill(2));
const RPC_CUSTODY = new PublicKey(new Uint8Array(32).fill(3));
const RPC_COLLATERAL_CUSTODY = new PublicKey(new Uint8Array(32).fill(4));

function positionAccountData(input: {
  sizeUsd?: bigint;
  collateralUsd?: bigint;
  realizedPnlUsd?: bigint;
  lockedAmount?: bigint;
  discriminator?: Uint8Array;
  owner?: PublicKey;
} = {}) {
  // Jupiter's currently allocated Position PDAs are 216 bytes. The documented
  // Position fields occupy the leading bytes and the remaining bytes are
  // retained as zero padding in this production-shaped fixture.
  const data = Buffer.alloc(216);
  data.set(input.discriminator ?? CURRENT_POSITION_DISCRIMINATOR, 0);
  let offset = 8;
  data.set((input.owner ?? RPC_OWNER).toBytes(), offset);
  offset += 32;
  data.set(RPC_POOL.toBytes(), offset);
  offset += 32;
  data.set(RPC_CUSTODY.toBytes(), offset);
  offset += 32;
  data.set(RPC_COLLATERAL_CUSTODY.toBytes(), offset);
  offset += 32;
  data.writeBigInt64LE(1_787_167_393n, offset);
  offset += 8;
  data.writeBigInt64LE(1_787_172_214n, offset);
  offset += 8;
  data[offset] = 1;
  offset += 1;
  data.writeBigUInt64LE(82_242_393n, offset);
  offset += 8;
  data.writeBigUInt64LE(input.sizeUsd ?? 0n, offset);
  offset += 8;
  data.writeBigUInt64LE(input.collateralUsd ?? 0n, offset);
  offset += 8;
  data.writeBigInt64LE(input.realizedPnlUsd ?? 0n, offset);
  offset += 8;
  data.writeBigUInt64LE(238_438_900n, offset);
  offset += 16;
  data.writeBigUInt64LE(input.lockedAmount ?? 0n, offset);
  offset += 8;
  data[offset] = 254;
  return data;
}

test("RPC absence is authoritative only for a clean empty owner-account scan", () => {
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 0,
    decodeFailureCount: 0,
    unclassifiedAccountCount: 0,
  }), true);
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 1,
    decodeFailureCount: 0,
    unclassifiedAccountCount: 0,
  }), false);
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 0,
    decodeFailureCount: 1,
    unclassifiedAccountCount: 1,
  }), false);
  assert.equal(isAuthoritativeJupiterRpcPositionAbsence({
    positionCount: 0,
    pendingTriggerCount: 0,
    decodeFailureCount: 0,
    unclassifiedAccountCount: 1,
  }), false);
});

test("RPC inventory rejects a decoded position mixed with an unclassified owner account", () => {
  assert.throws(() => assertCompleteJupiterRpcOwnerAccountClassification({
    ownerAccountCount: 2,
    positionCount: 1,
    pendingTriggerCount: 0,
    unclassifiedAccountCount: 1,
  }), /exposure is incomplete/i);

  assert.doesNotThrow(() => assertCompleteJupiterRpcOwnerAccountClassification({
    ownerAccountCount: 2,
    positionCount: 1,
    pendingTriggerCount: 1,
    unclassifiedAccountCount: 0,
  }));
});

test("a documented 216-byte zero-balance Position PDA proves authoritative absence", () => {
  const data = positionAccountData();
  assert.equal(data.byteLength, 216);

  const classified = classifyJupiterRpcOwnerAccounts(RPC_OWNER.toBase58(), [{
    accountRef: "closed-position",
    data,
  }]);

  assert.equal(classified.positions.length, 0);
  assert.equal(classified.pendingTriggers.length, 0);
  assert.deepEqual(classified.closedPositionAccountRefs, ["closed-position"]);
  assert.equal(classified.decodeFailureCount, 0);
  assert.equal(classified.unclassifiedAccountCount, 0);
  assert.equal(classified.authoritativePositionAbsence, true);
});

test("a documented 216-byte open Position PDA is returned as live inventory", () => {
  const data = positionAccountData({
    sizeUsd: 500_000_000n,
    collateralUsd: 25_000_000n,
    lockedAmount: 1_000_000n,
  });
  const classified = classifyJupiterRpcOwnerAccounts(RPC_OWNER.toBase58(), [{
    accountRef: "open-position",
    data,
  }]);

  assert.equal(classified.positions.length, 1);
  assert.equal(classified.positions[0]?.accountRef, "open-position");
  assert.equal(classified.positions[0]?.positionValue, 500);
  assert.equal(classified.closedPositionAccountRefs.length, 0);
  assert.equal(classified.authoritativePositionAbsence, false);
});

for (const [label, balances] of [
  ["collateral", { collateralUsd: 1n }],
  ["realized PnL", { realizedPnlUsd: 1n }],
  ["locked amount", { lockedAmount: 1n }],
] as const) {
  test(`a zero-sized Position with residual ${label} remains fail-closed`, () => {
    assert.throws(() => classifyJupiterRpcOwnerAccounts(RPC_OWNER.toBase58(), [{
      accountRef: "malformed-closed-position",
      data: positionAccountData(balances),
    }]), /exposure is incomplete/i);
  });
}

for (const [label, data] of [
  ["smaller", positionAccountData().subarray(0, 215)],
  ["oversized", Buffer.concat([positionAccountData(), Buffer.from([0])])],
] as const) {
  test(`a recognized Position using an unverified ${label} layout remains fail-closed`, () => {
    assert.throws(() => classifyJupiterRpcOwnerAccounts(RPC_OWNER.toBase58(), [{
      accountRef: `${label}-position-layout`,
      data,
    }]), /exposure is incomplete/i);
  });
}

test("a Position whose embedded owner does not match the scanned wallet remains fail-closed", () => {
  assert.throws(() => classifyJupiterRpcOwnerAccounts(RPC_OWNER.toBase58(), [{
    accountRef: "wrong-owner-position",
    data: positionAccountData({ owner: new PublicKey(new Uint8Array(32).fill(9)) }),
  }]), /exposure is incomplete/i);
});

test("an unknown 216-byte owner-scoped account remains fail-closed", () => {
  assert.throws(() => classifyJupiterRpcOwnerAccounts(RPC_OWNER.toBase58(), [{
    accountRef: "unknown-owner-account",
    data: positionAccountData({
      discriminator: Buffer.from("0102030405060708", "hex"),
    }),
  }]), /exposure is incomplete/i);
});

test("an open Position mixed with an unknown owner account remains fail-closed", () => {
  assert.throws(() => classifyJupiterRpcOwnerAccounts(RPC_OWNER.toBase58(), [
    {
      accountRef: "open-position",
      data: positionAccountData({
        sizeUsd: 500_000_000n,
        collateralUsd: 25_000_000n,
        lockedAmount: 1_000_000n,
      }),
    },
    {
      accountRef: "unknown-owner-account",
      data: positionAccountData({
        discriminator: Buffer.from("0102030405060708", "hex"),
      }),
    },
  ]), /exposure is incomplete/i);
});

test("nested and standalone TP/SL requests use Jupiter raw USD prices", () => {
  assert.deepEqual(getInitialPositionTpsl(signal()), [
    { receiveToken: "USDC", requestType: "tp", triggerPrice: "77250000" },
    { receiveToken: "USDC", requestType: "sl", triggerPrice: "75500000" },
  ]);
  assert.deepEqual(getStandalonePositionTpsl(signal()), [
    { entirePosition: true, receiveToken: "USDC", requestType: "tp", triggerPrice: "77250000" },
    { entirePosition: true, receiveToken: "USDC", requestType: "sl", triggerPrice: "75500000" },
  ]);
});

test("a deferred scalp TP preserves its volatility target above fees and the net-profit floor", () => {
  const rebased = rebaseTakeProfitForLivePosition(
    { side: "short", takeProfit: { enabled: true, priceUsd: 77.44154323703374 } },
    {
      side: "short",
      entryPriceUsd: "77458395",
      markPriceUsd: "77495000",
      sizeUsd: "5253436400",
      totalFeesUsd: "6309618",
    },
    1
  );

  assert.equal(typeof rebased, "number");
  if (typeof rebased !== "number") return;
  assert.ok(rebased < 77.44);
  assert.ok(rebased < 77.458395);
});

test("deferred scalp protection rebases both TP and SL from the confirmed fill", () => {
  const rebased = rebaseTpslForLivePosition(
    {
      side: "long",
      referenceEntryPriceUsd: 100,
      estimatedRoundTripFeeRate: 0.00205,
      takeProfit: { enabled: true, priceUsd: 102 },
      stopLoss: { enabled: true, priceUsd: 99 },
    },
    {
      side: "long",
      entryPriceUsd: "101000000",
      markPriceUsd: "101200000",
      sizeUsd: "1000000000",
      totalFeesUsd: "1000000",
    }
  );

  assert.equal(Number(rebased.takeProfitPrice?.toFixed(6)), 103.02);
  assert.equal(Number(rebased.stopLossPrice?.toFixed(6)), 99.99);
});

test("legacy non-scalp deferred TP behavior still moves beyond a crossed live mark", () => {
  const rebased = rebaseTakeProfitForLivePosition(
    { side: "long", takeProfit: { enabled: true, priceUsd: 100.02 } },
    {
      side: "long",
      entryPriceUsd: "100000000",
      markPriceUsd: "100200000",
      sizeUsd: "5000000000",
      totalFeesUsd: "6000000",
    }
  );

  assert.equal(typeof rebased, "number");
  if (typeof rebased !== "number") return;
  assert.ok(rebased > 100.2);
});

for (const testCase of [
  { name: "long TP", side: "long" as const, takeProfit: 101, stopLoss: 99, mark: 102.1, kind: "take-profit" },
  { name: "short TP", side: "short" as const, takeProfit: 99, stopLoss: 101, mark: 98, kind: "take-profit" },
  { name: "long SL", side: "long" as const, takeProfit: 102, stopLoss: 99, mark: 99.98, kind: "stop-loss" },
  { name: "short SL", side: "short" as const, takeProfit: 98, stopLoss: 101, mark: 100.02, kind: "stop-loss" },
]) {
  test(`a crossed ${testCase.name} requests an immediate close instead of widening protection`, () => {
    assert.throws(() => rebaseTpslForLivePosition(
      {
        side: testCase.side,
        referenceEntryPriceUsd: 100,
        takeProfit: { enabled: true, priceUsd: testCase.takeProfit },
        stopLoss: { enabled: true, priceUsd: testCase.stopLoss },
      },
      {
        side: testCase.side,
        entryPriceUsd: testCase.side === "long" ? "101000000" : "99000000",
        markPriceUsd: String(Math.round(testCase.mark * 1_000_000)),
        sizeUsd: "5000000000",
        totalFeesUsd: "5000000",
      }
    ), (error: unknown) => (
      error instanceof LivePositionTriggerAlreadyCrossedError
      && error.triggerKind === testCase.kind
    ));
  });
}

test("a nested TP/SL builder failure falls back to an entry transaction and defers protection", async () => {
  const requests: unknown[] = [];
  const built = await buildEntryWithTpslFallback(getInitialPositionTpsl(signal()), async (tpsl) => {
    requests.push(tpsl);
    if (tpsl.length) throw new Error("500 Internal Server Error");
    return { serializedTxBase64: "entry-transaction", tpsl: [] };
  });
  assert.equal(requests.length, 2);
  assert.equal(built.response.serializedTxBase64, "entry-transaction");
  assert.equal(built.tpslMode, "deferred");
});

test("a successful nested builder reports bundled TP/SL protection", async () => {
  const built = await buildEntryWithTpslFallback(getInitialPositionTpsl(signal()), async () => ({
    serializedTxBase64: "bundled-transaction",
    tpsl: [{ requestType: "tp" }, { requestType: "sl" }],
  }));
  assert.equal(built.tpslMode, "bundled");
});

test("scalp entries force deferred protection so confirmed fill prices are available", async () => {
  const requests: unknown[] = [];
  const built = await buildEntryWithTpslFallback(
    getInitialPositionTpsl(signal()),
    async (tpsl) => {
      requests.push(tpsl);
      return { serializedTxBase64: "entry-only", tpsl: [] };
    },
    { forceDeferredProtection: true }
  );

  assert.deepEqual(requests, [[]]);
  assert.equal(built.tpslMode, "deferred");
});
