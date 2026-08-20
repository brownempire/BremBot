import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type {
  JupiterPerpsAccountSnapshot,
  JupiterPerpsPendingTrigger,
  JupiterPerpsPosition,
  JupiterPerpsTransactionStatus,
  JupiterPerpsTrade,
} from "../lib/jupiterPerps";
import { classifyJupiterPerpsTransactionStatus } from "../lib/jupiterPerps";
import {
  acquireScalpProtectionRecoveryLease,
  beginScalpProtectionEntryRoute,
  createScalpEmergencyCloseSubmissionUncertainError,
  createScalpProtectionSubmissionUncertainError,
  createScalpProtectionRecoveryRecord,
  getScalpRecoveryExecutionPatch,
  hasConfirmedScalpRecoveryProtections,
  clearScalpProtectionRecovery,
  getScalpProtectionRecovery,
  reserveScalpProtectionRecovery,
  resolveScalpRecoveryPositionPubkey,
  runScalpProtectionRecovery,
  saveScalpProtectionRecovery,
  selectScalpProtectionRecoveryAuthority,
  submitAfterScalpRecoveryGuard,
  type ScalpProtectionRecoveryRecord,
} from "../lib/perps/scalpProtectionRecovery";
import { bindDiscoveredScalpRecoveryPosition } from "../lib/perps/tradingAgent";

function recovery(
  positionPubkey: string | null = null,
  walletAddress = "owner-wallet",
  executionId = "execution-1"
) {
  return createScalpProtectionRecoveryRecord({
    walletAddress,
    agentWalletAddress: "agent-wallet",
    executionId,
    signalId: "signal-1",
    entryTxid: "entry-tx-1",
    asset: "SOL",
    side: "long",
    market: "SOL-PERP",
    assetMint: "SOL",
    collateralUsd: 10,
    sizeUsd: 200,
    leverage: 20,
    maxSlippageBps: 100,
    takeProfitPrice: 75.5,
    stopLossPrice: 74.5,
    referenceEntryPriceUsd: 75,
    estimatedRoundTripFeeRate: 0.00205,
    positionPubkey,
    positionIdentitySource: positionPubkey ? "entry-response" : null,
    positionIdentityTxid: positionPubkey ? "entry-tx-1" : null,
    baselinePositionPubkeys: ["older-sol-position"],
    createdAt: "2026-08-19T12:00:00.000Z",
  });
}

function entryTrade(
  positionPubkey: string,
  overrides: Partial<JupiterPerpsTrade> = {}
): JupiterPerpsTrade {
  return {
    id: `trade-${positionPubkey}`,
    source: "live-api",
    positionPubkey,
    marketSymbol: "SOL",
    marketName: "SOL Perps",
    side: "long",
    action: "increase",
    orderType: "market",
    price: 75,
    sizeUsd: 200,
    collateralUsdDelta: 10,
    feeUsd: 0.2,
    pnl: null,
    pnlPercentage: null,
    txHash: "entry-tx-1",
    lastUpdated: Date.parse("2026-08-19T12:00:05.000Z"),
    createdAt: Date.parse("2026-08-19T12:00:05.000Z"),
    ...overrides,
  };
}

function entryRecovery(walletAddress: string, executionId: string) {
  return createScalpProtectionRecoveryRecord({
    walletAddress,
    agentWalletAddress: "agent-wallet",
    executionId,
    signalId: "entry-signal",
    entryTxid: null,
    asset: "SOL",
    side: "long",
    market: "SOL-PERP",
    assetMint: "SOL",
    collateralUsd: 10,
    sizeUsd: 200,
    leverage: 20,
    maxSlippageBps: 100,
    takeProfitPrice: 75.5,
    stopLossPrice: 74.5,
    referenceEntryPriceUsd: 75,
    estimatedRoundTripFeeRate: 0.00205,
    positionPubkey: null,
    baselinePositionPubkeys: [],
    createdAt: "2026-08-19T12:00:00.000Z",
  });
}

function position(positionPubkey: string, overrides: Partial<JupiterPerpsPosition> = {}): JupiterPerpsPosition {
  return {
    id: positionPubkey,
    source: "live-api",
    platformId: "jupiter-exchange",
    marketSymbol: "SOL",
    marketName: "SOL Perps",
    marketAddress: null,
    custodyAddress: null,
    collateralCustodyAddress: null,
    collateralSymbol: "USDC",
    imageUri: null,
    side: "long",
    entryPrice: 75,
    markPrice: 75.1,
    positionSize: 2.66,
    positionValue: 200,
    collateralValue: 10,
    leverage: 20,
    unrealizedPnl: 0.2,
    realizedPnl: 0,
    liquidationPrice: 71,
    fundingSnapshot: null,
    borrowSnapshot: null,
    takeProfit: null,
    stopLoss: null,
    markPriceIsLive: true,
    liquidationPriceIsEstimated: false,
    accountRef: positionPubkey,
    lastUpdated: Date.parse("2026-08-19T12:00:05.000Z"),
    ...overrides,
  };
}

function snapshot(
  positions: JupiterPerpsPosition[] = [],
  recentTrades: JupiterPerpsTrade[] = [],
  pendingTriggers: JupiterPerpsPendingTrigger[] = [],
  authoritativePositionAbsence = true
): JupiterPerpsAccountSnapshot {
  return {
    positions,
    pendingTriggers,
    recentTrades,
    readEvidence: {
      liveApiSucceeded: true,
      rpcSucceeded: authoritativePositionAbsence,
      authoritativePositionAbsence: authoritativePositionAbsence && positions.length === 0,
    },
  };
}

function trigger(
  kind: "take-profit" | "stop-loss",
  triggerPrice: number,
  overrides: Partial<JupiterPerpsPendingTrigger> = {}
): JupiterPerpsPendingTrigger {
  return {
    id: `${kind}-trigger`,
    source: "live-api",
    platformId: "jupiter-exchange",
    marketSymbol: "SOL",
    marketName: "SOL Perps",
    marketAddress: null,
    custodyAddress: null,
    collateralCustodyAddress: null,
    collateralSymbol: "USDC",
    side: "long",
    kind,
    triggerPrice,
    sizeDeltaUsd: 200,
    collateralDelta: null,
    entirePosition: true,
    triggerAboveThreshold: kind === "take-profit",
    executed: false,
    accountRef: `${kind}-request`,
    positionPubkey: "new-sol-position",
    positionRequestPubkey: `${kind}-request`,
    lastUpdated: Date.parse("2026-08-19T12:00:30.000Z"),
    ...overrides,
  };
}

class FakeRecoveryLeaseRedis {
  private readonly leases = new Map<string, { token: string; expiresAt: number }>();
  renewals = 0;

  private expire(key: string) {
    const current = this.leases.get(key);
    if (current && current.expiresAt <= Date.now()) this.leases.delete(key);
  }

  async set(key: string, value: string, options: { NX: true; PX: number }) {
    this.expire(key);
    if (this.leases.has(key)) return null;
    this.leases.set(key, { token: value, expiresAt: Date.now() + options.PX });
    return "OK";
  }

  async eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ) {
    const key = options.keys[0]!;
    this.expire(key);
    const current = this.leases.get(key);
    if (script.includes("PEXPIRE")) {
      if (current?.token !== options.arguments[0]) return 0;
      this.renewals += 1;
      current.expiresAt = Date.now() + Number(options.arguments[1]);
      return 1;
    }
    if (script.includes("DEL")) {
      if (current?.token !== options.arguments[0]) return 0;
      this.leases.delete(key);
      return 1;
    }
    throw new Error("Unexpected fake Redis script.");
  }

  forceOwnerForWallet(walletAddress: string, token: string, ttlMs = 60_000) {
    const key = `brembot:perps:scalp-protection-recovery-lease:v1:${walletAddress}`;
    this.leases.set(key, { token, expiresAt: Date.now() + ttlMs });
  }

  ownerForWallet(walletAddress: string) {
    const key = `brembot:perps:scalp-protection-recovery-lease:v1:${walletAddress}`;
    this.expire(key);
    return this.leases.get(key)?.token ?? null;
  }
}

test("Solana signature states classify definitive failure separately from ambiguous absence", () => {
  assert.equal(classifyJupiterPerpsTransactionStatus(null), "not-found");
  assert.equal(classifyJupiterPerpsTransactionStatus({ err: { InstructionError: [0, "Custom"] } }), "failed");
  assert.equal(classifyJupiterPerpsTransactionStatus({ err: null, confirmationStatus: "processed" }), "processing");
  assert.equal(classifyJupiterPerpsTransactionStatus({ err: null, confirmationStatus: "confirmed" }), "confirmed");
  assert.equal(classifyJupiterPerpsTransactionStatus({ err: null, confirmationStatus: "finalized" }), "confirmed");
});

test("a missing response pubkey persists a wallet-scoped fail-closed block", async () => {
  const saved: ScalpProtectionRecoveryRecord[] = [];
  let attachCalls = 0;
  let closeCalls = 0;

  const result = await runScalpProtectionRecovery(recovery(), {
    readSnapshot: async () => snapshot(),
    attachProtection: async () => {
      attachCalls += 1;
      return "unexpected";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "unexpected";
    },
    save: async (record) => { saved.push(record); },
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:15.000Z"),
  });

  assert.equal(result.status, "awaiting-position");
  assert.equal(result.blockNewEntries, true);
  assert.equal(result.record.positionPubkey, null);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.status, "awaiting-position");
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
});

test("a failed authoritative pre-entry save prevents risk submission", async () => {
  let submitCalls = 0;
  await assert.rejects(
    submitAfterScalpRecoveryGuard({
      record: recovery(),
      reserve: async () => { throw new Error("authoritative Redis write failed"); },
      submit: async () => {
        submitCalls += 1;
        return { txid: "must-not-submit" };
      },
    }),
    /authoritative Redis write failed/
  );
  assert.equal(submitCalls, 0);
});

test("wallet guard reservation is atomic and ownership-protected", async () => {
  const walletAddress = `owner-${crypto.randomUUID()}`;
  const first = recovery(null, walletAddress, "execution-a");
  const second = recovery(null, walletAddress, "execution-b");
  const reservations = await Promise.allSettled([
    reserveScalpProtectionRecovery(first),
    reserveScalpProtectionRecovery(second),
  ]);
  assert.equal(reservations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(reservations.filter((result) => result.status === "rejected").length, 1);

  const stored = await getScalpProtectionRecovery(walletAddress);
  assert.ok(stored);
  const owner = stored.recoveryId === first.recoveryId ? first : second;
  const intruder = owner.recoveryId === first.recoveryId ? second : first;
  await assert.rejects(saveScalpProtectionRecovery(intruder), /owns this wallet|another recovery/i);
  await assert.rejects(
    clearScalpProtectionRecovery(walletAddress, intruder.recoveryId),
    /owns this wallet|another recovery/i
  );
  assert.equal((await getScalpProtectionRecovery(walletAddress))?.recoveryId, owner.recoveryId);
  await clearScalpProtectionRecovery(walletAddress, owner.recoveryId);
  assert.equal(await getScalpProtectionRecovery(walletAddress), null);
});

test("concurrent recovery workers submit only one TP/SL transaction for a wallet", async () => {
  const walletAddress = `lease-owner-${crypto.randomUUID()}`;
  const record = recovery("new-sol-position", walletAddress, "lease-execution");
  let attachCalls = 0;
  let releaseAttach!: () => void;
  let signalAttachStarted!: () => void;
  const attachStarted = new Promise<void>((resolve) => { signalAttachStarted = resolve; });
  const attachGate = new Promise<void>((resolve) => { releaseAttach = resolve; });
  const dependencies = {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => {
      attachCalls += 1;
      signalAttachStarted();
      await attachGate;
      return "tpsl-tx";
    },
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  };

  const first = runScalpProtectionRecovery(record, dependencies);
  await attachStarted;
  await assert.rejects(
    runScalpProtectionRecovery(record, dependencies),
    /another scalp-protection recovery attempt is already active/i
  );
  releaseAttach();
  const result = await first;

  assert.equal(result.status, "protection-submitted");
  assert.equal(attachCalls, 1);
});

test("concurrent recovery workers submit only one emergency full close for a wallet", async () => {
  const walletAddress = `close-lease-owner-${crypto.randomUUID()}`;
  const record = recovery("new-sol-position", walletAddress, "close-lease-execution");
  let closeCalls = 0;
  let releaseClose!: () => void;
  let signalCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => { signalCloseStarted = resolve; });
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const dependencies = {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => { throw new Error("TP/SL rejected"); },
    emergencyClose: async () => {
      closeCalls += 1;
      signalCloseStarted();
      await closeGate;
      return "emergency-close-tx";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  };

  const first = runScalpProtectionRecovery(record, dependencies);
  await closeStarted;
  await assert.rejects(
    runScalpProtectionRecovery(record, dependencies),
    /another scalp-protection recovery attempt is already active/i
  );
  releaseClose();
  const result = await first;

  assert.equal(result.status, "emergency-close-pending");
  assert.equal(closeCalls, 1);
});

test("the production entry boundary holds the monitor lease from guard reservation through protection", async () => {
  const record = entryRecovery(`route-lease-${crypto.randomUUID()}`, "route-execution");
  let routeEntryCalls = 0;
  let routeProtectionCalls = 0;
  let monitorProtectionCalls = 0;
  let openEntryGate!: () => void;
  let openProtectionGate!: () => void;
  let signalEntryStarted!: () => void;
  let signalProtectionStarted!: () => void;
  const entryStarted = new Promise<void>((resolve) => { signalEntryStarted = resolve; });
  const protectionStarted = new Promise<void>((resolve) => { signalProtectionStarted = resolve; });
  const entryGate = new Promise<void>((resolve) => { openEntryGate = resolve; });
  const protectionGate = new Promise<void>((resolve) => { openProtectionGate = resolve; });

  const releaseRoute = await beginScalpProtectionEntryRoute(record);
  const route = (async () => {
    routeEntryCalls += 1;
    signalEntryStarted();
    await entryGate;
    routeProtectionCalls += 1;
    signalProtectionStarted();
    await protectionGate;
  })();
  await entryStarted;

  const monitorAttempt = () => runScalpProtectionRecovery(record, {
      readSnapshot: async () => snapshot([position("new-sol-position")]),
      attachProtection: async () => {
        monitorProtectionCalls += 1;
        return "duplicate-monitor-tpsl";
      },
      emergencyClose: async () => "unexpected",
      save: async () => undefined,
      clear: async () => undefined,
      now: () => Date.parse("2026-08-19T12:00:20.000Z"),
    });
  await assert.rejects(
    monitorAttempt(),
    /another scalp-protection recovery attempt is already active/i
  );

  openEntryGate();
  await protectionStarted;
  await assert.rejects(
    monitorAttempt(),
    /another scalp-protection recovery attempt is already active/i
  );

  openProtectionGate();
  await route;
  await releaseRoute();
  assert.equal(routeEntryCalls, 1);
  assert.equal(routeProtectionCalls, 1);
  assert.equal(monitorProtectionCalls, 0);
  await clearScalpProtectionRecovery(record.walletAddress, record.recoveryId);
});

test("a fresh atomic entry guard gives the direct route a no-side-effect monitor grace", async () => {
  const guarded = entryRecovery(`grace-owner-${crypto.randomUUID()}`, "grace-execution");
  let snapshotCalls = 0;
  let attachCalls = 0;
  let closeCalls = 0;
  const result = await runScalpProtectionRecovery(guarded, {
    readSnapshot: async () => {
      snapshotCalls += 1;
      return snapshot([position("new-sol-position")]);
    },
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-tpsl";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "duplicate-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:30.000Z"),
  });

  assert.equal(result.status, "entry-submission-pending");
  assert.equal(result.blockNewEntries, true);
  assert.equal(snapshotCalls, 0);
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
});

test("a post-TP/SL save failure leaves a durable reservation and cannot immediately duplicate protection", async () => {
  const record = recovery("new-sol-position", `post-tpsl-save-${crypto.randomUUID()}`, "post-tpsl-execution");
  let durableRecord = record;
  let saveCalls = 0;
  let attachCalls = 0;
  let closeCalls = 0;
  const events: string[] = [];

  await assert.rejects(
    runScalpProtectionRecovery(record, {
      readSnapshot: async () => snapshot([position("new-sol-position")]),
      attachProtection: async (_positionPubkey, reserved) => {
        events.push("attach");
        attachCalls += 1;
        assert.equal(reserved.status, "protection-submitted");
        assert.equal(durableRecord.status, "protection-submitted");
        return "accepted-tpsl";
      },
      emergencyClose: async () => {
        closeCalls += 1;
        return "must-not-close";
      },
      save: async (saved) => {
        saveCalls += 1;
        events.push(`save-${saved.status}`);
        if (saveCalls === 1) {
          durableRecord = saved;
          return;
        }
        throw new Error("post-submit Redis save failed");
      },
      clear: async () => undefined,
      now: () => Date.parse("2026-08-19T12:00:20.000Z"),
    }),
    /post-submit Redis save failed/
  );

  assert.deepEqual(events.slice(0, 2), ["save-protection-submitted", "attach"]);
  assert.equal(attachCalls, 1);
  assert.equal(closeCalls, 0);
  assert.equal(durableRecord.protectionTxid, null);
  assert.equal(durableRecord.lastAttemptAt, "2026-08-19T12:00:20.000Z");

  const pending = await runScalpProtectionRecovery(durableRecord, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-must-not-submit";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "duplicate-must-not-close";
    },
    save: async (saved) => { durableRecord = saved; },
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:25.000Z"),
  });
  assert.equal(pending.status, "protection-submitted");
  assert.equal(attachCalls, 1);
  assert.equal(closeCalls, 0);
});

test("an accepted TP/SL with a lost response stays pending without a duplicate or emergency close", async () => {
  const record = recovery("new-sol-position", `ambiguous-tpsl-${crypto.randomUUID()}`, "ambiguous-tpsl-execution");
  let attachCalls = 0;
  let closeCalls = 0;
  const saved: ScalpProtectionRecoveryRecord[] = [];
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => {
      attachCalls += 1;
      // Model Jupiter accepting the signed transaction before the response is
      // lost. This must never be treated as a definitely rejected build.
      throw createScalpProtectionSubmissionUncertainError(new Error("response connection reset"));
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "must-not-close";
    },
    save: async (next) => { saved.push(next); },
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  });

  assert.equal(result.status, "protection-submitted");
  assert.equal(result.blockNewEntries, true);
  assert.equal(attachCalls, 1);
  assert.equal(closeCalls, 0);
  assert.equal(saved[0]?.status, "protection-submitted");
  assert.match(result.message, /no duplicate transaction or emergency close/i);
});

test("a post-close save failure leaves a durable reservation and cannot immediately duplicate the emergency close", async () => {
  const record = recovery("new-sol-position", `post-close-save-${crypto.randomUUID()}`, "post-close-execution");
  let durableRecord = record;
  let saveCalls = 0;
  let attachCalls = 0;
  let closeCalls = 0;
  const events: string[] = [];

  await assert.rejects(
    runScalpProtectionRecovery(record, {
      readSnapshot: async () => snapshot([position("new-sol-position")]),
      attachProtection: async () => {
        attachCalls += 1;
        events.push("attach");
        throw new Error("TP/SL rejected");
      },
      emergencyClose: async (_positionPubkey, reserved) => {
        closeCalls += 1;
        events.push("close");
        assert.equal(reserved.status, "emergency-close-submitted");
        assert.equal(durableRecord.status, "emergency-close-submitted");
        return "accepted-close";
      },
      save: async (saved) => {
        saveCalls += 1;
        events.push(`save-${saved.status}`);
        if (saveCalls <= 2) {
          durableRecord = saved;
          return;
        }
        throw new Error("post-close Redis save failed");
      },
      clear: async () => undefined,
      now: () => Date.parse("2026-08-19T12:00:20.000Z"),
    }),
    /post-close Redis save failed/
  );

  assert.deepEqual(events.slice(0, 4), [
    "save-protection-submitted",
    "attach",
    "save-emergency-close-submitted",
    "close",
  ]);
  assert.equal(attachCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(durableRecord.emergencyCloseTxid, null);
  assert.equal(durableRecord.lastAttemptAt, "2026-08-19T12:00:20.000Z");

  const pending = await runScalpProtectionRecovery(durableRecord, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-must-not-attach";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "duplicate-must-not-close";
    },
    save: async (saved) => { durableRecord = saved; },
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:25.000Z"),
  });
  assert.equal(pending.status, "emergency-close-pending");
  assert.equal(attachCalls, 1);
  assert.equal(closeCalls, 1);
});

test("authoritative Redis ignores stale disk and malformed guards fail closed", () => {
  const staleDisk = recovery();
  assert.equal(selectScalpProtectionRecoveryAuthority({
    redisConfigured: true,
    redisValue: null,
    diskValue: staleDisk,
  }), null);
  assert.throws(() => selectScalpProtectionRecoveryAuthority({
    redisConfigured: true,
    redisValue: "{not-valid-json",
    diskValue: null,
  }), /malformed.*blocked/i);
  assert.equal(selectScalpProtectionRecoveryAuthority({
    redisConfigured: false,
    redisValue: null,
    diskValue: staleDisk,
  })?.recoveryId, staleDisk.recoveryId);
});

test("a later wallet snapshot discovers the submitted position but waits for live TP and SL confirmation", async () => {
  let attachedPosition: string | null = null;
  let clearedWallet: string | null = null;
  let attachCalls = 0;
  const submitted = await runScalpProtectionRecovery(recovery(), {
    readSnapshot: async () => snapshot(
      [position("new-sol-position")],
      [entryTrade("new-sol-position")]
    ),
    attachProtection: async (positionPubkey) => {
      attachCalls += 1;
      attachedPosition = positionPubkey;
      return "tpsl-tx";
    },
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async (walletAddress) => { clearedWallet = walletAddress; },
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  });

  assert.equal(attachedPosition, "new-sol-position");
  assert.equal(clearedWallet, null);
  assert.equal(submitted.status, "protection-submitted");
  assert.equal(submitted.record.protectionTxid, "tpsl-tx");
  assert.equal(submitted.blockNewEntries, true);

  const notVisibleYet = await runScalpProtectionRecovery(submitted.record, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-must-not-submit";
    },
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async (walletAddress) => { clearedWallet = walletAddress; },
    now: () => Date.parse("2026-08-19T12:00:30.000Z"),
  });
  assert.equal(notVisibleYet.status, "protection-submitted");
  assert.equal(notVisibleYet.blockNewEntries, true);
  assert.equal(clearedWallet, null);
  assert.equal(attachCalls, 1);

  const confirmed = await runScalpProtectionRecovery(notVisibleYet.record, {
    readSnapshot: async () => snapshot(
      [position("new-sol-position", { takeProfit: 75.52875, stopLoss: 74.5 })],
      [],
      [trigger("take-profit", 75.52875), trigger("stop-loss", 74.5)]
    ),
    attachProtection: async () => "unexpected",
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async (walletAddress) => { clearedWallet = walletAddress; },
    now: () => Date.parse("2026-08-19T12:00:40.000Z"),
  });
  assert.equal(confirmed.status, "protected");
  assert.equal(clearedWallet, "owner-wallet");
});

test("wrong, stale, or partial trigger requests cannot clear the recovery guard", () => {
  const record = {
    ...recovery("new-sol-position"),
    status: "protection-submitted" as const,
    protectionTxid: "tpsl-tx",
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
    expectedTakeProfitPrice: 75.52875,
    expectedStopLossPrice: 74.5,
  };
  const livePosition = position("new-sol-position", { takeProfit: 75.52875, stopLoss: 74.5 });

  assert.equal(hasConfirmedScalpRecoveryProtections(snapshot([livePosition]), livePosition, record), false);
  assert.equal(hasConfirmedScalpRecoveryProtections(
    snapshot([livePosition], [], [
      trigger("take-profit", 75.52875, { positionPubkey: "stale-position" }),
      trigger("stop-loss", 74.5, { positionPubkey: "stale-position" }),
    ]),
    livePosition,
    record
  ), false);
  assert.equal(hasConfirmedScalpRecoveryProtections(
    snapshot([livePosition], [], [
      trigger("take-profit", 75.52875, { lastUpdated: Date.parse("2026-08-19T11:55:00.000Z") }),
      trigger("stop-loss", 74.5, { lastUpdated: Date.parse("2026-08-19T11:55:00.000Z") }),
    ]),
    livePosition,
    record
  ), false);
  assert.equal(hasConfirmedScalpRecoveryProtections(
    snapshot([livePosition], [], [
      trigger("take-profit", 74.5),
      trigger("stop-loss", 75.5),
    ]),
    livePosition,
    record
  ), false);
  assert.equal(hasConfirmedScalpRecoveryProtections(
    snapshot([livePosition], [], [
      trigger("take-profit", 75.52875, { entirePosition: false, sizeDeltaUsd: 50 }),
      trigger("stop-loss", 74.5, { entirePosition: false, sizeDeltaUsd: 50 }),
    ]),
    livePosition,
    record
  ), false);
  assert.equal(hasConfirmedScalpRecoveryProtections(
    snapshot([livePosition], [], [trigger("take-profit", 75.52875), trigger("stop-loss", 74.5)]),
    livePosition,
    record
  ), true);
});

test("the recovery runner preserves the protection submission time and rejects stale matching triggers", async () => {
  const record = {
    ...recovery("new-sol-position"),
    status: "protection-submitted" as const,
    protectionTxid: "tpsl-tx",
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
    expectedTakeProfitPrice: 75.52875,
    expectedStopLossPrice: 74.5,
  };
  let attachCalls = 0;
  let cleared = false;

  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot(
      [position("new-sol-position", { takeProfit: 75.52875, stopLoss: 74.5 })],
      [],
      [
        trigger("take-profit", 75.52875, { lastUpdated: Date.parse("2026-08-19T11:55:00.000Z") }),
        trigger("stop-loss", 74.5, { lastUpdated: Date.parse("2026-08-19T11:55:00.000Z") }),
      ]
    ),
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-must-not-submit";
    },
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:00:25.000Z"),
  });

  assert.equal(result.status, "protection-submitted");
  assert.equal(result.record.lastAttemptAt, "2026-08-19T12:00:20.000Z");
  assert.equal(attachCalls, 0);
  assert.equal(cleared, false);
});

test("entry-route position discovery preserves the submitted freshness boundary", () => {
  const reserved = {
    ...recovery(null),
    status: "protection-submitted" as const,
    protectionTxid: null,
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
    lastError: "The direct route reserved TP/SL submission.",
    expectedTakeProfitPrice: 75.52875,
    expectedStopLossPrice: 74.5,
  };
  const bound = bindDiscoveredScalpRecoveryPosition(
    reserved,
    "new-sol-position",
    "2026-08-19T12:00:25.000Z"
  );
  const livePosition = position("new-sol-position", { takeProfit: 75.52875, stopLoss: 74.5 });

  assert.equal(bound.positionPubkey, "new-sol-position");
  assert.equal(bound.positionIdentitySource, "entry-transaction");
  assert.equal(bound.positionIdentityTxid, "entry-tx-1");
  assert.equal(bound.status, "protection-submitted");
  assert.equal(bound.lastAttemptAt, "2026-08-19T12:00:20.000Z");
  assert.equal(bound.lastError, "The direct route reserved TP/SL submission.");
  assert.equal(hasConfirmedScalpRecoveryProtections(
    snapshot([livePosition], [], [
      trigger("take-profit", 75.52875, { lastUpdated: Date.parse("2026-08-19T11:55:00.000Z") }),
      trigger("stop-loss", 74.5, { lastUpdated: Date.parse("2026-08-19T11:55:00.000Z") }),
    ]),
    livePosition,
    bound
  ), false);
});

test("the entry transaction resolves its actual position even when an older same-side position exists", () => {
  const entryTrade = {
    id: "trade-1",
    source: "live-api",
    positionPubkey: "increased-position",
    marketSymbol: "SOL",
    marketName: "SOL Perps",
    side: "long",
    action: "increase",
    orderType: "market",
    price: 75,
    sizeUsd: 200,
    collateralUsdDelta: 10,
    feeUsd: 0.2,
    pnl: null,
    pnlPercentage: null,
    txHash: "entry-tx-1",
    lastUpdated: Date.parse("2026-08-19T12:00:05.000Z"),
    createdAt: Date.parse("2026-08-19T12:00:05.000Z"),
  } satisfies JupiterPerpsTrade;

  assert.equal(
    resolveScalpRecoveryPositionPubkey(
      recovery(),
      snapshot([position("older-sol-position"), position("increased-position")], [entryTrade])
    ),
    "increased-position"
  );
});

test("failed protection submits an emergency full close and blocks until closure is confirmed", async () => {
  const saved: ScalpProtectionRecoveryRecord[] = [];
  let closePosition: string | null = null;
  let cleared = false;
  const first = await runScalpProtectionRecovery(recovery("new-sol-position"), {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => { throw new Error("TP/SL rejected"); },
    emergencyClose: async (positionPubkey) => {
      closePosition = positionPubkey;
      return "emergency-close-tx";
    },
    save: async (record) => { saved.push(record); },
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  });

  assert.equal(closePosition, "new-sol-position");
  assert.equal(cleared, false);
  assert.equal(first.status, "emergency-close-pending");
  assert.equal(first.blockNewEntries, true);
  assert.equal(first.record.status, "emergency-close-submitted");
  assert.equal(first.record.emergencyCloseTxid, "emergency-close-tx");
  assert.equal(saved.at(-1)?.status, "emergency-close-submitted");

  const second = await runScalpProtectionRecovery(first.record, {
    readSnapshot: async () => snapshot(),
    attachProtection: async () => "unexpected",
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async (walletAddress) => {
      assert.equal(walletAddress, "owner-wallet");
      cleared = true;
    },
    now: () => Date.parse("2026-08-19T12:00:40.000Z"),
  });

  assert.equal(cleared, true);
  assert.equal(second.status, "position-closed");
  assert.equal(second.blockNewEntries, true);
});

test("an empty non-authoritative snapshot cannot falsely confirm an emergency close", async () => {
  const record = {
    ...recovery("new-sol-position"),
    status: "emergency-close-submitted" as const,
    emergencyCloseTxid: "close-tx",
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let cleared = false;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([], [], [], false),
    attachProtection: async () => "unexpected",
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:00:40.000Z"),
  });
  assert.equal(result.status, "emergency-close-pending");
  assert.equal(result.blockNewEntries, true);
  assert.equal(cleared, false);
});

test("an authoritatively absent protection-submitted position resolves as closed", async () => {
  const record = {
    ...recovery("new-sol-position"),
    status: "protection-submitted" as const,
    protectionTxid: "tpsl-tx",
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let cleared = false;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot(),
    attachProtection: async () => "unexpected",
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:00:55.000Z"),
  });
  assert.equal(result.status, "position-closed");
  assert.equal(cleared, true);
});

test("a fresh direct-route protection reservation cannot be cleared by propagation-lag absence", async () => {
  const record = {
    ...recovery("new-sol-position"),
    status: "protection-submitted" as const,
    protectionTxid: null,
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let cleared = false;
  let attachCalls = 0;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot(),
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-must-not-submit";
    },
    emergencyClose: async () => "duplicate-must-not-close",
    save: async () => undefined,
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:00:25.000Z"),
  });
  assert.equal(result.status, "protection-submitted");
  assert.equal(result.blockNewEntries, true);
  assert.equal(cleared, false);
  assert.equal(attachCalls, 0);
});

for (const entryStatus of ["confirmed", "processing", "not-found"] as const) {
  test(`an old signature-less direct-route intent stays blocked when its entry is ${entryStatus}`, async () => {
    const record = {
      ...recovery("new-sol-position", `absent-entry-${entryStatus}-${crypto.randomUUID()}`),
      status: "protection-submitted" as const,
      protectionTxid: null,
      lastAttemptAt: "2026-08-19T12:00:20.000Z",
    };
    let cleared = false;
    let attachCalls = 0;
    let closeCalls = 0;
    const result = await runScalpProtectionRecovery(record, {
      readSnapshot: async () => snapshot(),
      readTransactionStatus: async (txid) => {
        assert.equal(txid, "entry-tx-1");
        return entryStatus;
      },
      attachProtection: async () => {
        attachCalls += 1;
        return "must-not-protect";
      },
      emergencyClose: async () => {
        closeCalls += 1;
        return "must-not-close";
      },
      save: async () => undefined,
      clear: async () => { cleared = true; },
      now: () => Date.parse("2026-08-19T12:01:00.000Z"),
    });

    assert.equal(result.status, "protection-submitted");
    assert.equal(result.blockNewEntries, true);
    assert.equal(cleared, false);
    assert.equal(attachCalls, 0);
    assert.equal(closeCalls, 0);
    assert.match(result.message, /signature-less protection intent.*blocked/i);
  });
}

test("an unavailable old direct-route entry status remains blocked on authoritative absence", async () => {
  const record = {
    ...recovery("new-sol-position", `absent-entry-unavailable-${crypto.randomUUID()}`),
    status: "protection-submitted" as const,
    protectionTxid: null,
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let cleared = false;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot(),
    readTransactionStatus: async () => { throw new Error("RPC unavailable"); },
    attachProtection: async () => "must-not-protect",
    emergencyClose: async () => "must-not-close",
    save: async () => undefined,
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });
  assert.equal(result.status, "protection-submitted");
  assert.equal(cleared, false);
  assert.match(result.message, /could not be reconciled.*signature-less protection intent/i);
});

test("only an explicitly failed direct-route entry may clear an old signature-less intent on proven absence", async () => {
  const record = {
    ...recovery("new-sol-position", `absent-entry-failed-${crypto.randomUUID()}`),
    status: "protection-submitted" as const,
    protectionTxid: null,
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let cleared = false;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot(),
    readTransactionStatus: async () => "failed",
    attachProtection: async () => "must-not-protect",
    emergencyClose: async () => "must-not-close",
    save: async () => undefined,
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });
  assert.equal(result.status, "entry-not-found");
  assert.equal(cleared, true);
  assert.match(result.message, /definitively failed on-chain/i);
});

test("an awaiting entry clears only after the grace window and authoritative absence", async () => {
  const record = {
    ...recovery(),
    status: "awaiting-position" as const,
  };
  let cleared = false;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot(),
    attachProtection: async () => "unexpected",
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async () => { cleared = true; },
    now: () => Date.parse("2026-08-19T12:11:00.000Z"),
  });
  assert.equal(result.status, "entry-not-found");
  assert.equal(cleared, true);
});

test("trade history proves an awaiting entry opened and closed", async () => {
  const record = {
    ...recovery(),
    status: "awaiting-position" as const,
  };
  const entryTrade = {
    id: "entry-trade",
    source: "live-api",
    positionPubkey: "opened-then-closed",
    marketSymbol: "SOL",
    marketName: "SOL Perps",
    side: "long",
    action: "increase",
    orderType: "market",
    price: 75,
    sizeUsd: 200,
    collateralUsdDelta: 10,
    feeUsd: 0.2,
    pnl: null,
    pnlPercentage: null,
    txHash: "entry-tx-1",
    lastUpdated: Date.parse("2026-08-19T12:00:05.000Z"),
    createdAt: Date.parse("2026-08-19T12:00:05.000Z"),
  } satisfies JupiterPerpsTrade;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([], [entryTrade]),
    attachProtection: async () => "unexpected",
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:11:00.000Z"),
  });
  assert.equal(result.status, "position-closed");
  assert.equal(result.record.positionPubkey, "opened-then-closed");
});

test("later discovery is written back to the original execution audit patch", async () => {
  const pending = await runScalpProtectionRecovery(recovery(), {
    readSnapshot: async () => snapshot(
      [position("late-position")],
      [entryTrade("late-position")]
    ),
    attachProtection: async () => "submitted-tpsl",
    emergencyClose: async () => "unexpected",
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  });
  const patch = getScalpRecoveryExecutionPatch(pending);
  assert.equal(patch?.positionPubkey, "late-position");
  assert.equal(patch?.txid, "entry-tx-1");
  assert.equal(patch?.strategyClass, "scalp");
  assert.equal(patch?.status, "submitted");

  if (!pending.record) throw new Error("Expected a persisted recovery record.");
  const closedRecord = {
    ...pending.record,
    status: "emergency-close-submitted" as const,
    emergencyCloseTxid: "close-tx",
  };
  const closedPatch = getScalpRecoveryExecutionPatch({
    status: "position-closed",
    blockNewEntries: true,
    record: closedRecord,
    message: "closed",
  });
  assert.equal(closedPatch?.status, "closed");
  assert.equal(closedPatch?.reasonCode, "SCALP_EMERGENCY_CLOSE_CONFIRMED");
});

for (const transactionStatus of ["confirmed", "processing", "not-found"] as const) {
  test(`a ${transactionStatus} TP/SL signature is never blindly resubmitted after the grace window`, async () => {
    const record = {
      ...recovery("new-sol-position", `protection-${transactionStatus}-${crypto.randomUUID()}`),
      status: "protection-submitted" as const,
      protectionTxid: "known-protection-signature",
      lastAttemptAt: "2026-08-19T12:00:20.000Z",
    };
    let attachCalls = 0;
    let closeCalls = 0;
    const result = await runScalpProtectionRecovery(record, {
      readSnapshot: async () => snapshot([position("new-sol-position")]),
      readTransactionStatus: async (txid) => {
        assert.equal(txid, "known-protection-signature");
        return transactionStatus;
      },
      attachProtection: async () => {
        attachCalls += 1;
        return "duplicate-protection";
      },
      emergencyClose: async () => {
        closeCalls += 1;
        return "duplicate-close";
      },
      save: async () => undefined,
      clear: async () => undefined,
      now: () => Date.parse("2026-08-19T12:01:00.000Z"),
    });

    assert.equal(result.status, "protection-submitted");
    assert.equal(result.record.protectionTxid, "known-protection-signature");
    assert.equal(attachCalls, 0);
    assert.equal(closeCalls, 0);
    assert.match(result.message, /without resubmission|remains blocked/i);
  });
}

test("an unavailable TP/SL signature status fails closed without resubmission", async () => {
  const record = {
    ...recovery("new-sol-position", `protection-unavailable-${crypto.randomUUID()}`),
    status: "protection-submitted" as const,
    protectionTxid: "unavailable-protection-signature",
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let attachCalls = 0;
  let closeCalls = 0;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    readTransactionStatus: async () => { throw new Error("RPC unavailable"); },
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-protection";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "duplicate-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });

  assert.equal(result.status, "protection-submitted");
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
  assert.match(result.message, /could not be reconciled|remains blocked/i);
});

test("only a definitively failed TP/SL signature is retried", async () => {
  const record = {
    ...recovery("new-sol-position", `protection-failed-${crypto.randomUUID()}`),
    status: "protection-submitted" as const,
    protectionTxid: "failed-protection-signature",
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let attachCalls = 0;
  let closeCalls = 0;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    readTransactionStatus: async (): Promise<JupiterPerpsTransactionStatus> => "failed",
    attachProtection: async () => {
      attachCalls += 1;
      return "replacement-protection-signature";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "unexpected-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });

  assert.equal(result.status, "protection-submitted");
  assert.equal(result.record.protectionTxid, "replacement-protection-signature");
  assert.equal(attachCalls, 1);
  assert.equal(closeCalls, 0);
});

test("an old signature-less TP/SL reservation remains ambiguous instead of retrying or closing", async () => {
  const record = {
    ...recovery("new-sol-position", `protection-no-signature-${crypto.randomUUID()}`),
    status: "protection-submitted" as const,
    protectionTxid: null,
    protectionRetryable: false,
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let attachCalls = 0;
  let closeCalls = 0;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => {
      attachCalls += 1;
      return "duplicate-protection";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "duplicate-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });

  assert.equal(result.status, "protection-submitted");
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
  assert.match(result.message, /ambiguous/i);
});

for (const transactionStatus of ["confirmed", "processing", "not-found"] as const) {
  test(`a ${transactionStatus} emergency-close signature is never blindly resubmitted`, async () => {
    const record = {
      ...recovery("new-sol-position", `close-${transactionStatus}-${crypto.randomUUID()}`),
      status: "emergency-close-submitted" as const,
      emergencyCloseTxid: "known-close-signature",
      lastAttemptAt: "2026-08-19T12:00:20.000Z",
    };
    let closeCalls = 0;
    const result = await runScalpProtectionRecovery(record, {
      readSnapshot: async () => snapshot([position("new-sol-position")]),
      readTransactionStatus: async () => transactionStatus,
      attachProtection: async () => "unexpected-protection",
      emergencyClose: async () => {
        closeCalls += 1;
        return "duplicate-close";
      },
      save: async () => undefined,
      clear: async () => undefined,
      now: () => Date.parse("2026-08-19T12:01:00.000Z"),
    });

    assert.equal(result.status, "emergency-close-pending");
    assert.equal(result.record.emergencyCloseTxid, "known-close-signature");
    assert.equal(closeCalls, 0);
    assert.match(result.message, /without resubmission|remains blocked/i);
  });
}

test("an unavailable emergency-close status fails closed and a definitive failure alone retries", async () => {
  const base = {
    ...recovery("new-sol-position", `close-reconcile-${crypto.randomUUID()}`),
    status: "emergency-close-submitted" as const,
    emergencyCloseTxid: "close-signature",
    lastAttemptAt: "2026-08-19T12:00:20.000Z",
  };
  let closeCalls = 0;
  const unavailable = await runScalpProtectionRecovery(base, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    readTransactionStatus: async () => { throw new Error("RPC unavailable"); },
    attachProtection: async () => "unexpected-protection",
    emergencyClose: async () => {
      closeCalls += 1;
      return "duplicate-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });
  assert.equal(unavailable.status, "emergency-close-pending");
  assert.equal(closeCalls, 0);

  const failed = await runScalpProtectionRecovery(base, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    readTransactionStatus: async () => "failed",
    attachProtection: async () => "unexpected-protection",
    emergencyClose: async () => {
      closeCalls += 1;
      return "replacement-close-signature";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });
  assert.equal(failed.status, "emergency-close-pending");
  assert.equal(failed.record.emergencyCloseTxid, "replacement-close-signature");
  assert.equal(closeCalls, 1);
});

test("a lost emergency-close response never becomes retryable without a definitive on-chain failure", async () => {
  let closeCalls = 0;
  const first = await runScalpProtectionRecovery(
    recovery("new-sol-position", `uncertain-close-${crypto.randomUUID()}`),
    {
      readSnapshot: async () => snapshot([position("new-sol-position")]),
      attachProtection: async () => { throw new Error("TP/SL build rejected"); },
      emergencyClose: async () => {
        closeCalls += 1;
        throw createScalpEmergencyCloseSubmissionUncertainError(new Error("response lost"));
      },
      save: async () => undefined,
      clear: async () => undefined,
      now: () => Date.parse("2026-08-19T12:00:20.000Z"),
    }
  );
  assert.equal(first.status, "emergency-close-pending");
  assert.equal(first.record.emergencyCloseRetryable, false);

  const later = await runScalpProtectionRecovery(first.record, {
    readSnapshot: async () => snapshot([position("new-sol-position")]),
    attachProtection: async () => "unexpected-protection",
    emergencyClose: async () => {
      closeCalls += 1;
      return "duplicate-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:01:00.000Z"),
  });
  assert.equal(later.status, "emergency-close-pending");
  assert.equal(closeCalls, 1);
  assert.match(later.message, /ambiguous/i);
});

test("a unique same-side live position is not bound without entry-transaction evidence", async () => {
  const record = recovery(null, `unrelated-position-${crypto.randomUUID()}`);
  const lonePosition = position("unrelated-same-side-position");
  assert.equal(resolveScalpRecoveryPositionPubkey(record, snapshot([lonePosition])), null);

  let attachCalls = 0;
  let closeCalls = 0;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([lonePosition]),
    attachProtection: async () => {
      attachCalls += 1;
      return "must-not-protect";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "must-not-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  });
  assert.equal(result.status, "awaiting-position");
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
});

test("a reused position pubkey with a later increase cannot inherit an older recovery guard", async () => {
  const record = recovery("reused-position", `reused-position-${crypto.randomUUID()}`);
  const conflictingTrade = entryTrade("reused-position", {
    id: "later-unrelated-increase",
    txHash: "different-entry-signature",
    createdAt: Date.parse("2026-08-19T12:00:10.000Z"),
    lastUpdated: Date.parse("2026-08-19T12:00:10.000Z"),
  });
  const liveSnapshot = snapshot([position("reused-position")], [conflictingTrade]);
  assert.equal(resolveScalpRecoveryPositionPubkey(record, liveSnapshot), null);
  assert.equal(resolveScalpRecoveryPositionPubkey(
    record,
    snapshot([position("reused-position")], [
      entryTrade("reused-position", {
        id: "undated-unrelated-increase",
        txHash: "undated-entry-signature",
        createdAt: null,
        lastUpdated: null,
      }),
    ])
  ), null);

  let attachCalls = 0;
  let closeCalls = 0;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => liveSnapshot,
    attachProtection: async () => {
      attachCalls += 1;
      return "must-not-protect";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "must-not-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  });
  assert.equal(result.blockNewEntries, true);
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
  assert.match(result.message, /cannot be bound|identity/i);
});

test("a bound pubkey resolving to the wrong side is blocked without protection or close", async () => {
  const record = recovery("bound-position", `wrong-side-${crypto.randomUUID()}`);
  let attachCalls = 0;
  let closeCalls = 0;
  const result = await runScalpProtectionRecovery(record, {
    readSnapshot: async () => snapshot([position("bound-position", { side: "short" })]),
    attachProtection: async () => {
      attachCalls += 1;
      return "must-not-protect";
    },
    emergencyClose: async () => {
      closeCalls += 1;
      return "must-not-close";
    },
    save: async () => undefined,
    clear: async () => undefined,
    now: () => Date.parse("2026-08-19T12:00:20.000Z"),
  });
  assert.equal(result.status, "protection-pending");
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
  assert.match(result.message, /different side or market/i);
});

test("the Redis recovery lease renews, rejects overlap, and stale release cannot delete a replacement owner", async () => {
  const redis = new FakeRecoveryLeaseRedis();
  const record = recovery(null, `renewable-lease-${crypto.randomUUID()}`);
  const first = await acquireScalpProtectionRecoveryLease(record, {
    redis,
    redisConfigured: true,
    leaseTtlMs: 200,
    renewalIntervalMs: 10,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.ok(redis.renewals > 0);
    await first.assertOwned();
    await assert.rejects(
      acquireScalpProtectionRecoveryLease(record, {
        redis,
        redisConfigured: true,
        leaseTtlMs: 200,
        renewalIntervalMs: 10,
      }),
      /already active/i
    );

    redis.forceOwnerForWallet(record.walletAddress, "replacement-worker-token");
    await assert.rejects(first.assertOwned(), /lost to another worker|no longer owned/i);
  } finally {
    await first();
  }
  assert.equal(redis.ownerForWallet(record.walletAddress), "replacement-worker-token");
});

test("worker A losing its lease to worker B aborts before any recovery write or Jupiter side effect", async () => {
  const redis = new FakeRecoveryLeaseRedis();
  const record = recovery("new-sol-position", `lost-worker-lease-${crypto.randomUUID()}`);
  let saveCalls = 0;
  let attachCalls = 0;
  let closeCalls = 0;

  await assert.rejects(
    runScalpProtectionRecovery(record, {
      withRecoveryLease: async (ownedRecord, operation) => {
        const workerA = await acquireScalpProtectionRecoveryLease(ownedRecord, {
          redis,
          redisConfigured: true,
          leaseTtlMs: 1_000,
          renewalIntervalMs: 250,
        });
        try {
          await workerA.assertOwned();
          return await operation(workerA.assertOwned);
        } finally {
          await workerA();
        }
      },
      readSnapshot: async () => {
        redis.forceOwnerForWallet(record.walletAddress, "worker-b-token");
        return snapshot([position("new-sol-position")]);
      },
      attachProtection: async () => {
        attachCalls += 1;
        return "must-not-protect";
      },
      emergencyClose: async () => {
        closeCalls += 1;
        return "must-not-close";
      },
      save: async () => {
        saveCalls += 1;
      },
      clear: async () => undefined,
      now: () => Date.parse("2026-08-19T12:00:20.000Z"),
    }),
    /lost to another worker|no longer owned/i
  );
  assert.equal(saveCalls, 0);
  assert.equal(attachCalls, 0);
  assert.equal(closeCalls, 0);
  assert.equal(redis.ownerForWallet(record.walletAddress), "worker-b-token");
});

test("entry-route discovery refuses to bind a position before an entry signature exists", () => {
  assert.throws(
    () => bindDiscoveredScalpRecoveryPosition(entryRecovery("unsigned-wallet", "unsigned-execution"), "position"),
    /without the submitted entry transaction signature/i
  );
});
