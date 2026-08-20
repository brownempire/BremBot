import fs from "node:fs";
import crypto from "node:crypto";

import { z } from "zod";

import type {
  JupiterPerpsAccountSnapshot,
  JupiterPerpsPosition,
  JupiterPerpsTransactionStatus,
} from "@/lib/jupiterPerps";
import type { PerpsUserExecution } from "@/lib/perps/sessionTypes";
import { getRedisClient } from "@/lib/server/redis";

const RECOVERY_FILE = process.env.PERPS_SCALP_PROTECTION_RECOVERY_FILE
  || "/tmp/brembot-perps-scalp-protection-recovery.json";
const RECOVERY_REDIS_KEY = "brembot:perps:scalp-protection-recovery:v1";
const RECOVERY_LEASE_KEY_PREFIX = "brembot:perps:scalp-protection-recovery-lease:v1";
const RECOVERY_LEASE_TTL_MS = 5 * 60_000;
const EMERGENCY_CLOSE_RETRY_MS = 30_000;
const DIRECT_ENTRY_ROUTE_GRACE_MS = 60_000;
const ENTRY_DISCOVERY_GRACE_MS = 10 * 60_000;
const SAVE_OWNED_RECOVERY_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or decoded['recoveryId'] ~= ARGV[2] then return -1 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;
const CLEAR_OWNED_RECOVERY_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or decoded['recoveryId'] ~= ARGV[2] then return -1 end
return redis.call('HDEL', KEYS[1], ARGV[1])
`;
const RELEASE_OWNED_RECOVERY_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const RENEW_OWNED_RECOVERY_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const localRecoveryLeases = new Set<string>();

export const SCALP_PROTECTION_SUBMISSION_UNCERTAIN_CODE = "SCALP_PROTECTION_SUBMISSION_UNCERTAIN";

function createScalpSideEffectSubmissionUncertainError(label: string, error: unknown) {
  const detail = error instanceof Error
    ? error.message
    : "Jupiter's TP/SL submission result could not be confirmed.";
  return Object.assign(
    new Error(`The ${label} request may have been accepted but its transaction signature was not confirmed: ${detail}`),
    {
      code: SCALP_PROTECTION_SUBMISSION_UNCERTAIN_CODE,
      cause: error,
    }
  );
}

export function createScalpProtectionSubmissionUncertainError(error: unknown) {
  return createScalpSideEffectSubmissionUncertainError("TP/SL", error);
}

export function createScalpEmergencyCloseSubmissionUncertainError(error: unknown) {
  return createScalpSideEffectSubmissionUncertainError("emergency-close", error);
}

export function isScalpProtectionSubmissionUncertainError(error: unknown) {
  return (error as { code?: unknown } | null)?.code === SCALP_PROTECTION_SUBMISSION_UNCERTAIN_CODE;
}

export const scalpProtectionRecoveryRecordSchema = z.object({
  recoveryId: z.string().trim().min(1),
  walletAddress: z.string().trim().min(1),
  agentWalletAddress: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
  signalId: z.string().trim().min(1),
  entryTxid: z.string().trim().min(1).nullable(),
  asset: z.enum(["SOL", "ETH", "BTC"]),
  side: z.enum(["long", "short"]),
  market: z.string().trim().min(1),
  assetMint: z.string().trim().min(1),
  collateralUsd: z.number().finite().positive(),
  sizeUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  maxSlippageBps: z.number().int().min(1).max(10_000),
  takeProfitPrice: z.number().finite().positive().nullable(),
  stopLossPrice: z.number().finite().positive().nullable(),
  referenceEntryPriceUsd: z.number().finite().positive().nullable(),
  estimatedRoundTripFeeRate: z.number().finite().positive().max(0.01),
  positionPubkey: z.string().trim().min(1).nullable(),
  positionIdentitySource: z.enum(["entry-response", "entry-transaction"]).nullable().default(null),
  positionIdentityTxid: z.string().trim().min(1).nullable().default(null),
  baselinePositionPubkeys: z.array(z.string().trim().min(1)),
  status: z.enum([
    "entry-submission-pending",
    "awaiting-position",
    "protection-pending",
    "protection-submitted",
    "emergency-close-submitted",
  ]),
  protectionTxid: z.string().trim().min(1).nullable(),
  expectedTakeProfitPrice: z.number().finite().positive().nullable().default(null),
  expectedStopLossPrice: z.number().finite().positive().nullable().default(null),
  protectionRetryable: z.boolean().default(false),
  emergencyCloseTxid: z.string().trim().min(1).nullable(),
  emergencyCloseRetryable: z.boolean().default(false),
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().trim().min(1).nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ScalpProtectionRecoveryRecord = z.infer<typeof scalpProtectionRecoveryRecordSchema>;

export type ScalpProtectionRecoveryResult =
  | {
      status: "no-pending-recovery";
      blockNewEntries: false;
      record: null;
      message: string;
    }
  | {
      status: "protected" | "position-closed" | "entry-not-found";
      blockNewEntries: true;
      record: ScalpProtectionRecoveryRecord;
      message: string;
    }
  | {
      status: "entry-submission-pending" | "awaiting-position" | "protection-pending" | "protection-submitted" | "emergency-close-pending";
      blockNewEntries: true;
      record: ScalpProtectionRecoveryRecord;
      message: string;
    };

export type ScalpProtectionSubmission = string | {
  txid: string | null;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
};

type RecoveryLeaseRedisClient = {
  set: (
    key: string,
    value: string,
    options: { NX: true; PX: number }
  ) => Promise<string | null>;
  eval: (
    script: string,
    options: { keys: string[]; arguments: string[] }
  ) => Promise<unknown>;
};

export type ScalpProtectionRecoveryLeaseOptions = {
  redis?: RecoveryLeaseRedisClient | null;
  redisConfigured?: boolean;
  leaseTtlMs?: number;
  renewalIntervalMs?: number;
};

export type ScalpProtectionRecoveryLease = (() => Promise<void>) & {
  /**
   * Re-validates the owner token before a durable write or external Jupiter
   * side effect. A worker that has lost its lease must stop immediately.
   */
  assertOwned: () => Promise<void>;
};

export async function acquireScalpProtectionRecoveryLease(
  record: ScalpProtectionRecoveryRecord,
  options: ScalpProtectionRecoveryLeaseOptions = {}
): Promise<ScalpProtectionRecoveryLease> {
  const leaseKey = `${RECOVERY_LEASE_KEY_PREFIX}:${record.walletAddress}`;
  const leaseToken = `${record.recoveryId}:${crypto.randomUUID()}`;
  const configured = options.redisConfigured ?? redisIsConfigured();
  const leaseTtlMs = Math.max(25, options.leaseTtlMs ?? RECOVERY_LEASE_TTL_MS);
  const hasInjectedRedis = Object.prototype.hasOwnProperty.call(options, "redis");
  const redis = hasInjectedRedis
    ? options.redis ?? null
    : await getRedisClient().catch((error) => {
        if (configured) throw error;
        return null;
      });

  if (configured && !redis) {
    throw new Error("Authoritative scalp-protection recovery leasing is unavailable; recovery remains blocked.");
  }
  if (!redis) {
    if (localRecoveryLeases.has(record.walletAddress)) {
      throw new Error("Another scalp-protection recovery attempt is already active for this wallet.");
    }
    localRecoveryLeases.add(record.walletAddress);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      localRecoveryLeases.delete(record.walletAddress);
    };
    return Object.assign(release, {
      assertOwned: async () => {
        if (released || !localRecoveryLeases.has(record.walletAddress)) {
          throw new Error("The scalp-protection recovery lease is no longer owned by this worker.");
        }
      },
    });
  }
  const leaseRedis = redis as RecoveryLeaseRedisClient;

  let acquired: string | null;
  try {
    acquired = await leaseRedis.set(leaseKey, leaseToken, {
      NX: true,
      PX: leaseTtlMs,
    });
  } catch (error) {
    throw new Error(
      `Authoritative scalp-protection recovery leasing is unavailable: ${error instanceof Error ? error.message : "Redis lease failed"}`
    );
  }
  if (acquired !== "OK") {
    throw new Error("Another scalp-protection recovery attempt is already active for this wallet.");
  }

  const renewalIntervalMs = Math.max(
    5,
    Math.min(options.renewalIntervalMs ?? Math.floor(leaseTtlMs / 3), Math.floor(leaseTtlMs / 2))
  );
  let released = false;
  let ownershipLostError: Error | null = null;
  let safelyOwnedUntil = Date.now() + leaseTtlMs;
  let renewalInFlight: Promise<boolean> | null = null;
  const renew = () => {
    if (released || ownershipLostError) return Promise.resolve(false);
    if (renewalInFlight) return renewalInFlight;
    const renewal = leaseRedis.eval(RENEW_OWNED_RECOVERY_LEASE_SCRIPT, {
      keys: [leaseKey],
      arguments: [leaseToken, String(leaseTtlMs)],
    }).then((result) => {
      if (Number(result) !== 1) {
        ownershipLostError = new Error(
          "The scalp-protection recovery lease was lost to another worker; this worker is forbidden from submitting or persisting further actions."
        );
        clearInterval(renewalTimer);
        return false;
      }
      safelyOwnedUntil = Date.now() + leaseTtlMs;
      return true;
    }).catch((error) => {
      if (Date.now() >= safelyOwnedUntil) {
        ownershipLostError = new Error(
          `The scalp-protection recovery lease could not be renewed before its safe ownership window expired: ${error instanceof Error ? error.message : "Redis renewal failed"}`
        );
        clearInterval(renewalTimer);
      }
      throw error;
    }).finally(() => {
      renewalInFlight = null;
    });
    renewalInFlight = renewal;
    return renewal;
  };
  const renewalTimer = setInterval(() => {
    void renew().catch(() => {
      // A transient heartbeat failure is retried while the last confirmed TTL
      // is still valid. assertOwned() never permits a state write or external
      // side effect unless a synchronous CAS renewal succeeds.
    });
  }, renewalIntervalMs);
  renewalTimer.unref?.();
  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(renewalTimer);
    await renewalInFlight?.catch(() => undefined);
    await leaseRedis.eval(RELEASE_OWNED_RECOVERY_LEASE_SCRIPT, {
      keys: [leaseKey],
      arguments: [leaseToken],
    }).catch(() => undefined);
  };
  return Object.assign(release, {
    assertOwned: async () => {
      if (released) {
        throw new Error("The scalp-protection recovery lease has already been released.");
      }
      if (ownershipLostError) throw ownershipLostError;
      try {
        const renewed = await renew();
        if (!renewed) {
          throw ownershipLostError ?? new Error("The scalp-protection recovery lease is no longer owned.");
        }
      } catch (error) {
        if (ownershipLostError) throw ownershipLostError;
        throw new Error(
          `The scalp-protection recovery lease could not be authoritatively revalidated; no state write or external side effect is allowed: ${error instanceof Error ? error.message : "Redis renewal failed"}`
        );
      }
    },
  });
}

export async function withScalpProtectionRecoveryLease<T>(
  record: ScalpProtectionRecoveryRecord,
  operation: (assertLeaseOwned: () => Promise<void>) => Promise<T>
) {
  const lease = await acquireScalpProtectionRecoveryLease(record);
  try {
    await lease.assertOwned();
    return await operation(lease.assertOwned);
  } finally {
    await lease();
  }
}

/**
 * Production entry boundary: the durable wallet guard is created first, then
 * the same distributed lease used by monitor recovery is acquired before any
 * signed entry is sent. The caller must hold the returned release handle until
 * the entry has either confirmed TP/SL or durably reserved its fail-closed
 * recovery state.
 */
export async function beginScalpProtectionEntryRoute(
  record: ScalpProtectionRecoveryRecord
) {
  await reserveScalpProtectionRecovery(record);
  return acquireScalpProtectionRecoveryLease(record);
}

export function getScalpRecoveryExecutionPatch(
  result: ScalpProtectionRecoveryResult
): Partial<PerpsUserExecution> | null {
  if (!result.record) return null;
  const base: Partial<PerpsUserExecution> = {
    txid: result.record.entryTxid,
    positionPubkey: result.record.positionPubkey,
    strategyClass: "scalp",
  };
  if (result.status === "protected") {
    return {
      ...base,
      status: "confirmed",
      reasonCode: "SCALP_PROTECTION_CONFIRMED",
      reasonMessage: "The live Jupiter position confirms both take-profit and stop-loss protection.",
      errorMessage: null,
    };
  }
  if (result.status === "position-closed") {
    const emergencyClose = result.record.status === "emergency-close-submitted";
    return {
      ...base,
      status: "closed",
      reasonCode: emergencyClose ? "SCALP_EMERGENCY_CLOSE_CONFIRMED" : "SCALP_POSITION_CLOSED_CONFIRMED",
      reasonMessage: emergencyClose
        ? "The fail-closed emergency exit is confirmed and the position is no longer open."
        : "The previously submitted scalp position is confirmed closed.",
      errorMessage: null,
    };
  }
  if (result.status === "entry-not-found") {
    return {
      ...base,
      status: "cancelled",
      reasonCode: "SCALP_ENTRY_NOT_FOUND",
      reasonMessage: "No Jupiter position appeared during the conservative post-submit discovery window.",
    };
  }
  if (result.record.positionPubkey) {
    return {
      ...base,
      status: "submitted",
      reasonCode: result.status === "emergency-close-pending"
        ? "SCALP_EMERGENCY_CLOSE_PENDING"
        : "SCALP_PROTECTION_RECOVERY_PENDING",
      reasonMessage: result.message,
      errorMessage: result.record.lastError,
    };
  }
  return base;
}

function readDiskStore() {
  try {
    if (!fs.existsSync(RECOVERY_FILE)) return {} as Record<string, unknown>;
    const parsed = JSON.parse(fs.readFileSync(RECOVERY_FILE, "utf8"));
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {} as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function writeDiskStore(store: Record<string, unknown>) {
  try {
    fs.writeFileSync(RECOVERY_FILE, JSON.stringify(store), "utf8");
    return true;
  } catch {
    return false;
  }
}

function parseRecord(value: unknown) {
  const parsed = scalpProtectionRecoveryRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseSerializedRecord(value: string | null) {
  if (!value) return null;
  try {
    return parseRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function selectScalpProtectionRecoveryAuthority(input: {
  redisConfigured: boolean;
  redisValue: string | null;
  diskValue: unknown;
}) {
  if (!input.redisConfigured) return parseRecord(input.diskValue);
  if (input.redisValue === null) return null;
  const record = parseSerializedRecord(input.redisValue);
  if (!record) {
    throw new Error("The authoritative Redis scalp-protection guard is malformed; live entries are blocked.");
  }
  return record;
}

function redisIsConfigured() {
  return Boolean(process.env.REDIS_URL?.trim());
}

/**
 * Returns a wallet-scoped unresolved entry. Redis is authoritative when it is
 * configured; the disk copy lets a local daemon survive a process restart.
 * A configured-but-unavailable Redis fails closed instead of silently losing
 * the guard that prevents another entry.
 */
export async function getScalpProtectionRecovery(walletAddress: string) {
  const disk = readDiskStore();
  const diskRecord = parseRecord(disk[walletAddress]);
  const redis = await getRedisClient().catch((error) => {
    if (redisIsConfigured()) throw error;
    return null;
  });
  if (!redis) return selectScalpProtectionRecoveryAuthority({
    redisConfigured: false,
    redisValue: null,
    diskValue: diskRecord,
  });

  let raw: string | null;
  try {
    raw = await redis.hGet(RECOVERY_REDIS_KEY, walletAddress);
  } catch (error) {
    throw new Error(
      `Authoritative scalp-protection recovery state is unavailable: ${error instanceof Error ? error.message : "Redis read failed"}`
    );
  }
  const redisRecord = selectScalpProtectionRecoveryAuthority({
    redisConfigured: true,
    redisValue: raw,
    diskValue: diskRecord,
  });
  if (!redisRecord && diskRecord) {
    delete disk[walletAddress];
    writeDiskStore(disk);
  }
  return redisRecord;
}

export async function listPendingScalpProtectionRecoveryRecordsAuthoritative() {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) {
    throw new Error("Authoritative Redis scalp-protection recovery storage is unavailable.");
  }
  let values: string[];
  try {
    values = await redis.hVals(RECOVERY_REDIS_KEY);
  } catch (error) {
    throw new Error(
      `Authoritative scalp-protection recoveries could not be listed: ${error instanceof Error ? error.message : "Redis read failed"}`
    );
  }
  return values.map((value) => {
    const record = parseSerializedRecord(value);
    if (!record) {
      throw new Error("An authoritative Redis scalp-protection recovery is malformed; monitor recovery is blocked.");
    }
    return record;
  });
}

export async function listPendingScalpProtectionRecoveryWalletsAuthoritative() {
  return (await listPendingScalpProtectionRecoveryRecordsAuthoritative())
    .map((record) => record.walletAddress);
}

export async function saveScalpProtectionRecovery(record: ScalpProtectionRecoveryRecord) {
  const parsed = scalpProtectionRecoveryRecordSchema.parse(record);
  const redis = await getRedisClient().catch((error) => {
    if (redisIsConfigured()) throw error;
    return null;
  });
  if (redis) {
    try {
      const result = Number(await redis.eval(SAVE_OWNED_RECOVERY_SCRIPT, {
        keys: [RECOVERY_REDIS_KEY],
        arguments: [parsed.walletAddress, parsed.recoveryId, JSON.stringify(parsed)],
      }));
      if (result !== 1) {
        throw new Error(result === -1
          ? "another recovery owns this wallet guard"
          : "the wallet recovery guard no longer exists");
      }
    } catch (error) {
      throw new Error(
        `Scalp-protection recovery state could not be saved to Redis: ${error instanceof Error ? error.message : "Redis write failed"}`
      );
    }
  }
  const disk = readDiskStore();
  const existingDisk = parseRecord(disk[parsed.walletAddress]);
  if (!redis && existingDisk && existingDisk.recoveryId !== parsed.recoveryId) {
    throw new Error("Another scalp-protection recovery owns this wallet's local guard.");
  }
  if (!redis && !existingDisk) {
    throw new Error("The local scalp-protection recovery guard no longer exists.");
  }
  disk[parsed.walletAddress] = parsed;
  const wroteDisk = writeDiskStore(disk);
  if (!wroteDisk && !redis) {
    throw new Error("Scalp-protection recovery state could not be persisted; live entries must remain blocked.");
  }
  return parsed;
}

export async function reserveScalpProtectionRecovery(record: ScalpProtectionRecoveryRecord) {
  const parsed = scalpProtectionRecoveryRecordSchema.parse(record);
  const redis = await getRedisClient().catch((error) => {
    if (redisIsConfigured()) throw error;
    return null;
  });
  if (redis) {
    const reserved = await redis.hSetNX(RECOVERY_REDIS_KEY, parsed.walletAddress, JSON.stringify(parsed));
    if (!reserved) {
      throw new Error("A scalp-protection recovery already owns this wallet; concurrent entry is blocked.");
    }
  }
  const disk = readDiskStore();
  if (!redis && parseRecord(disk[parsed.walletAddress])) {
    throw new Error("A local scalp-protection recovery already owns this wallet; concurrent entry is blocked.");
  }
  disk[parsed.walletAddress] = parsed;
  if (!writeDiskStore(disk) && !redis) {
    throw new Error("The scalp-protection guard could not be persisted locally; entry is blocked.");
  }
  return parsed;
}

export async function clearScalpProtectionRecovery(walletAddress: string, recoveryId: string) {
  const redis = await getRedisClient().catch((error) => {
    if (redisIsConfigured()) throw error;
    return null;
  });
  if (redis) {
    try {
      const result = Number(await redis.eval(CLEAR_OWNED_RECOVERY_SCRIPT, {
        keys: [RECOVERY_REDIS_KEY],
        arguments: [walletAddress, recoveryId],
      }));
      if (result === -1) throw new Error("another recovery owns this wallet guard");
    } catch (error) {
      throw new Error(
        `Scalp-protection recovery state could not be cleared from Redis: ${error instanceof Error ? error.message : "Redis delete failed"}`
      );
    }
  }
  const disk = readDiskStore();
  const existingDisk = parseRecord(disk[walletAddress]);
  if (!redis && existingDisk && existingDisk.recoveryId !== recoveryId) {
    throw new Error("Another scalp-protection recovery owns this wallet's local guard.");
  }
  delete disk[walletAddress];
  if (!writeDiskStore(disk) && !redis) {
    throw new Error("Scalp-protection recovery state could not be cleared from local storage.");
  }
}

/** The submit callback is never reached unless the recovery guard is durable. */
export async function submitAfterScalpRecoveryGuard<T>(options: {
  record: ScalpProtectionRecoveryRecord;
  reserve?: (record: ScalpProtectionRecoveryRecord) => Promise<unknown>;
  submit: () => Promise<T>;
}) {
  await (options.reserve ?? reserveScalpProtectionRecovery)(options.record);
  return options.submit();
}

export function createScalpProtectionRecoveryRecord(input: Omit<
  ScalpProtectionRecoveryRecord,
  "recoveryId" | "positionIdentitySource" | "positionIdentityTxid" | "status" | "protectionTxid" | "expectedTakeProfitPrice" | "expectedStopLossPrice" | "protectionRetryable" | "emergencyCloseTxid" | "emergencyCloseRetryable" | "attemptCount" | "lastError" | "lastAttemptAt" | "createdAt" | "updatedAt"
> & {
  createdAt?: string;
  positionIdentitySource?: ScalpProtectionRecoveryRecord["positionIdentitySource"];
  positionIdentityTxid?: string | null;
}) {
  const now = input.createdAt ?? new Date().toISOString();
  return scalpProtectionRecoveryRecordSchema.parse({
    ...input,
    recoveryId: `scalp-protection:${input.walletAddress}:${input.executionId}`,
    positionIdentitySource: input.positionIdentitySource ?? null,
    positionIdentityTxid: input.positionIdentityTxid ?? null,
    status: input.entryTxid
      ? input.positionPubkey ? "protection-pending" : "awaiting-position"
      : "entry-submission-pending",
    protectionTxid: null,
    expectedTakeProfitPrice: null,
    expectedStopLossPrice: null,
    protectionRetryable: false,
    emergencyCloseTxid: null,
    emergencyCloseRetryable: false,
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function updateScalpProtectionRecoveryRecord(
  record: ScalpProtectionRecoveryRecord,
  patch: Partial<ScalpProtectionRecoveryRecord>,
  now = new Date().toISOString()
) {
  return scalpProtectionRecoveryRecordSchema.parse({
    ...record,
    ...patch,
    recoveryId: record.recoveryId,
    walletAddress: record.walletAddress,
    updatedAt: now,
  });
}

function matchesRecoveryAssetSymbol(symbolValue: string, asset: ScalpProtectionRecoveryRecord["asset"]) {
  const symbol = symbolValue.trim().toUpperCase();
  return symbol === asset
    || symbol === `${asset}-PERP`
    || symbol.startsWith(`${asset}/`)
    || symbol.startsWith(`${asset}-`);
}

function matchesRecoveryAsset(position: JupiterPerpsPosition, asset: ScalpProtectionRecoveryRecord["asset"]) {
  return matchesRecoveryAssetSymbol(position.marketSymbol, asset);
}

export type ScalpRecoveryPositionBinding = {
  positionPubkey: string;
  source: "entry-response" | "entry-transaction";
  entryTxid: string;
};

function hasConflictingPositionEpisode(
  record: ScalpProtectionRecoveryRecord,
  snapshot: JupiterPerpsAccountSnapshot,
  positionPubkey: string
) {
  const recordCreatedAt = Date.parse(record.createdAt);
  return snapshot.recentTrades.some((trade) => (
    trade.positionPubkey === positionPubkey
    && trade.txHash !== record.entryTxid
    && /^(increase|open)$/i.test(trade.action.trim())
    && (
      typeof trade.createdAt !== "number"
      || !Number.isFinite(trade.createdAt)
      || !Number.isFinite(recordCreatedAt)
      || trade.createdAt >= recordCreatedAt - 15_000
    )
  ));
}

/**
 * A recovery may bind only to evidence produced by its own entry transaction.
 * A unique same-side position is not sufficient: another app or a manual trade
 * can create exactly that shape while our entry response is missing.
 */
export function resolveScalpRecoveryPositionBinding(
  record: ScalpProtectionRecoveryRecord,
  snapshot: JupiterPerpsAccountSnapshot
): ScalpRecoveryPositionBinding | null {
  if (
    record.positionPubkey
    && record.entryTxid
    && record.positionIdentitySource
    && record.positionIdentityTxid === record.entryTxid
    && !hasConflictingPositionEpisode(record, snapshot, record.positionPubkey)
  ) {
    return {
      positionPubkey: record.positionPubkey,
      source: record.positionIdentitySource,
      entryTxid: record.entryTxid,
    };
  }

  if (!record.entryTxid) return null;
  const transactionPositions = [...new Set(snapshot.recentTrades.flatMap((trade) => (
    trade.txHash === record.entryTxid
    && trade.side === record.side
    && /^(increase|open)$/i.test(trade.action.trim())
    && matchesRecoveryAssetSymbol(trade.marketSymbol, record.asset)
    && trade.positionPubkey
    && !record.baselinePositionPubkeys.includes(trade.positionPubkey)
      ? [trade.positionPubkey]
      : []
  )))];
  if (transactionPositions.length !== 1) return null;
  const positionPubkey = transactionPositions[0]!;
  if (hasConflictingPositionEpisode(record, snapshot, positionPubkey)) return null;
  return { positionPubkey, source: "entry-transaction", entryTxid: record.entryTxid };
}

export function resolveScalpRecoveryPositionPubkey(
  record: ScalpProtectionRecoveryRecord,
  snapshot: JupiterPerpsAccountSnapshot
) {
  return resolveScalpRecoveryPositionBinding(record, snapshot)?.positionPubkey ?? null;
}

function findPosition(snapshot: JupiterPerpsAccountSnapshot, positionPubkey: string) {
  return snapshot.positions.find((position) => position.accountRef === positionPubkey) ?? null;
}

function matchesRecoveryPositionIdentity(
  position: JupiterPerpsPosition,
  record: ScalpProtectionRecoveryRecord
) {
  return position.source !== "mock"
    && position.side === record.side
    && matchesRecoveryAsset(position, record.asset);
}

function provesAuthoritativePositionAbsence(snapshot: JupiterPerpsAccountSnapshot) {
  return snapshot.readEvidence?.authoritativePositionAbsence === true;
}

function expectedRecoveryTriggerPrice(
  kind: "take-profit" | "stop-loss",
  position: JupiterPerpsPosition,
  record: ScalpProtectionRecoveryRecord
) {
  const exact = kind === "take-profit"
    ? record.expectedTakeProfitPrice
    : record.expectedStopLossPrice;
  if (exact) return { price: exact, exact: true };
  const requested = kind === "take-profit" ? record.takeProfitPrice : record.stopLossPrice;
  const entryPrice = position.entryPrice;
  const referenceEntry = record.referenceEntryPriceUsd;
  if (!requested || !entryPrice || !referenceEntry) return null;
  const requestedMoveRatio = Math.abs(requested - referenceEntry) / referenceEntry;
  if (kind === "stop-loss") {
    const move = entryPrice * requestedMoveRatio;
    return { price: record.side === "long" ? entryPrice - move : entryPrice + move, exact: false };
  }
  const sizeUsd = position.positionValue ?? record.sizeUsd;
  if (!(sizeUsd > 0)) return null;
  const requestedGrossProfitUsd = requestedMoveRatio * sizeUsd;
  const requiredGrossProfitUsd = sizeUsd * record.estimatedRoundTripFeeRate + 1;
  const move = entryPrice * Math.max(requestedGrossProfitUsd, requiredGrossProfitUsd) / sizeUsd;
  return { price: record.side === "long" ? entryPrice + move : entryPrice - move, exact: false };
}

function triggerCoversFullPosition(
  trigger: JupiterPerpsAccountSnapshot["pendingTriggers"][number],
  position: JupiterPerpsPosition
) {
  if (trigger.entirePosition) return true;
  const requestedSize = trigger.sizeDeltaUsd;
  const liveSize = position.positionValue;
  return typeof requestedSize === "number"
    && Number.isFinite(requestedSize)
    && typeof liveSize === "number"
    && Number.isFinite(liveSize)
    && Math.abs(requestedSize) >= Math.abs(liveSize) * 0.995;
}

export function hasConfirmedScalpRecoveryProtections(
  snapshot: JupiterPerpsAccountSnapshot,
  position: JupiterPerpsPosition | null,
  record: ScalpProtectionRecoveryRecord
) {
  if (
    !position
    || !record.positionPubkey
    || typeof position.entryPrice !== "number"
    || !Number.isFinite(position.entryPrice)
    || position.entryPrice <= 0
  ) return false;
  const confirmsKind = (kind: "take-profit" | "stop-loss", requiredPrice: number | null) => {
    if (requiredPrice === null) return true;
    const expected = expectedRecoveryTriggerPrice(kind, position, record);
    if (!expected) return false;
    return snapshot.pendingTriggers.some((trigger) => {
      const protectionSubmittedAt = record.status === "protection-submitted"
        ? Date.parse(record.lastAttemptAt ?? "")
        : null;
      const triggerIsFresh = protectionSubmittedAt === null
        || (
          Number.isFinite(protectionSubmittedAt)
          && typeof trigger.lastUpdated === "number"
          && Number.isFinite(trigger.lastUpdated)
          && trigger.lastUpdated >= protectionSubmittedAt - 15_000
        );
      if (
        trigger.positionPubkey !== record.positionPubkey
        || trigger.kind !== kind
        || trigger.executed
        || !triggerIsFresh
        || !triggerCoversFullPosition(trigger, position)
        || typeof trigger.triggerPrice !== "number"
        || !Number.isFinite(trigger.triggerPrice)
      ) return false;
      const directionallyValid = record.side === "long"
        ? kind === "take-profit"
          ? trigger.triggerPrice > (position.entryPrice ?? 0)
          : trigger.triggerPrice < (position.entryPrice ?? Number.POSITIVE_INFINITY)
        : kind === "take-profit"
          ? trigger.triggerPrice < (position.entryPrice ?? Number.POSITIVE_INFINITY)
          : trigger.triggerPrice > (position.entryPrice ?? 0);
      if (!directionallyValid) return false;
      const toleranceRatio = expected.exact ? 0.0001 : 0.0025;
      const tolerance = Math.max(0.00001, Math.abs(expected.price) * toleranceRatio);
      return Math.abs(trigger.triggerPrice - expected.price) <= tolerance;
    });
  };
  return confirmsKind("take-profit", record.takeProfitPrice)
    && confirmsKind("stop-loss", record.stopLossPrice);
}

export function scalpProtectionRecoveryToSignal(record: ScalpProtectionRecoveryRecord) {
  return {
    signalId: record.signalId,
    strategyId: "bremlogic-agent-recovery",
    market: record.market,
    assetMint: record.assetMint,
    side: record.side,
    action: "open" as const,
    collateralUsd: record.collateralUsd,
    sizeUsd: record.sizeUsd,
    leverage: record.leverage,
    maxSlippageBps: record.maxSlippageBps,
    takeProfit: { enabled: record.takeProfitPrice !== null, priceUsd: record.takeProfitPrice },
    stopLoss: { enabled: record.stopLossPrice !== null, priceUsd: record.stopLossPrice },
    referenceEntryPriceUsd: record.referenceEntryPriceUsd,
    estimatedRoundTripFeeRate: record.estimatedRoundTripFeeRate,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reason: "Recover protection for a submitted scalp entry.",
    walletAddress: record.agentWalletAddress,
    source: "ui-local" as const,
  };
}

export type ScalpProtectionRecoveryDependencies = {
  readSnapshot: () => Promise<JupiterPerpsAccountSnapshot>;
  readTransactionStatus?: (txid: string) => Promise<JupiterPerpsTransactionStatus>;
  attachProtection: (positionPubkey: string, record: ScalpProtectionRecoveryRecord) => Promise<ScalpProtectionSubmission | null>;
  emergencyClose: (positionPubkey: string, record: ScalpProtectionRecoveryRecord) => Promise<string | null>;
  save?: (record: ScalpProtectionRecoveryRecord) => Promise<unknown>;
  clear?: (walletAddress: string, recoveryId: string) => Promise<unknown>;
  beforeClear?: (
    resolution: "protected" | "position-closed" | "entry-not-found",
    record: ScalpProtectionRecoveryRecord,
    message: string
  ) => Promise<unknown>;
  now?: () => number;
  withRecoveryLease?: <T>(
    record: ScalpProtectionRecoveryRecord,
    operation: (assertLeaseOwned: () => Promise<void>) => Promise<T>
  ) => Promise<T>;
};

async function inspectRecoveryTransaction(
  dependencies: ScalpProtectionRecoveryDependencies,
  txid: string
): Promise<{ status: JupiterPerpsTransactionStatus | "unavailable"; detail: string | null }> {
  if (!dependencies.readTransactionStatus) {
    return { status: "unavailable", detail: "No authoritative Solana transaction-status reader is configured." };
  }
  try {
    return { status: await dependencies.readTransactionStatus(txid), detail: null };
  } catch (error) {
    return {
      status: "unavailable",
      detail: error instanceof Error ? error.message : "Solana transaction status is unavailable.",
    };
  }
}

function transactionPendingMessage(
  action: "entry" | "TP/SL" | "emergency close",
  txid: string,
  inspection: Awaited<ReturnType<typeof inspectRecoveryTransaction>>
) {
  if (inspection.status === "confirmed") {
    return `${action} transaction ${txid} is confirmed, but its live effect is not visible yet; recovery remains blocked without resubmission.`;
  }
  if (inspection.status === "processing") {
    return `${action} transaction ${txid} is still processing; recovery remains blocked without resubmission.`;
  }
  if (inspection.status === "not-found") {
    return `${action} transaction ${txid} is not present in authoritative RPC history yet; that is ambiguous rather than a definitive failure, so recovery remains blocked without resubmission.`;
  }
  return `${action} transaction ${txid} could not be reconciled (${inspection.detail ?? "status unavailable"}); recovery remains blocked without resubmission.`;
}

async function runScalpProtectionRecoveryUnlocked(
  record: ScalpProtectionRecoveryRecord,
  dependencies: ScalpProtectionRecoveryDependencies,
  assertLeaseOwned: () => Promise<void>
): Promise<ScalpProtectionRecoveryResult> {
  const persist = dependencies.save ?? saveScalpProtectionRecovery;
  const remove = dependencies.clear ?? clearScalpProtectionRecovery;
  const save = async (next: ScalpProtectionRecoveryRecord) => {
    await assertLeaseOwned();
    return persist(next);
  };
  const clear = async (walletAddress: string, recoveryId: string) => {
    await assertLeaseOwned();
    return remove(walletAddress, recoveryId);
  };
  const beforeClear = async (
    resolution: "protected" | "position-closed" | "entry-not-found",
    next: ScalpProtectionRecoveryRecord,
    message: string
  ) => {
    if (!dependencies.beforeClear) return;
    await assertLeaseOwned();
    await dependencies.beforeClear(resolution, next, message);
  };
  const nowMs = dependencies.now?.() ?? Date.now();
  const now = new Date(nowMs).toISOString();

  // The entry route owns the first minute after it atomically creates the
  // wallet guard. During this interval it may be submitting the entry and
  // writing back its tx/position references. A monitor must not infer or
  // protect that same fill concurrently. If the route dies, recovery resumes
  // after the short grace period and the longer discovery guard still blocks
  // every new entry.
  const createdAt = Date.parse(record.createdAt);
  if (
    record.status === "entry-submission-pending"
    && Number.isFinite(createdAt)
    && nowMs - createdAt < DIRECT_ENTRY_ROUTE_GRACE_MS
  ) {
    return {
      status: "entry-submission-pending",
      blockNewEntries: true,
      record,
      message: "The direct entry route still owns this newly reserved scalp submission; monitor recovery is waiting without submitting another transaction.",
    };
  }

  let snapshot: JupiterPerpsAccountSnapshot;
  try {
    snapshot = await dependencies.readSnapshot();
  } catch (error) {
    const message = `Unable to inspect the submitted scalp position: ${error instanceof Error ? error.message : "wallet snapshot failed"}`;
    const pending = updateScalpProtectionRecoveryRecord(record, {
      attemptCount: record.attemptCount + 1,
      lastAttemptAt: now,
      lastError: message,
    }, now);
    await save(pending);
    return { status: record.status === "emergency-close-submitted" ? "emergency-close-pending" : record.status, blockNewEntries: true, record: pending, message };
  }

  if (record.status === "emergency-close-submitted" && record.positionPubkey) {
    const livePosition = findPosition(snapshot, record.positionPubkey);
    if (!livePosition) {
      if (!provesAuthoritativePositionAbsence(snapshot)) {
        const message = "The position was absent from the latest API response, but the RPC owner scan did not confirm closure; new entries remain blocked.";
        const pending = updateScalpProtectionRecoveryRecord(record, {
          attemptCount: record.attemptCount + 1,
          lastAttemptAt: now,
          lastError: message,
        }, now);
        await save(pending);
        return { status: "emergency-close-pending", blockNewEntries: true, record: pending, message };
      }
      const message = "The emergency close is confirmed; the previous scalp recovery guard was cleared.";
      await beforeClear("position-closed", record, message);
      await clear(record.walletAddress, record.recoveryId);
      return {
        status: "position-closed",
        blockNewEntries: true,
        record,
        message,
      };
    }
    const binding = resolveScalpRecoveryPositionBinding(record, snapshot);
    if (
      !binding
      || binding.positionPubkey !== record.positionPubkey
      || !matchesRecoveryPositionIdentity(livePosition, record)
    ) {
      const message = "The visible position cannot be proven to be the execution episode owned by this recovery guard; no emergency-close transaction will be submitted.";
      const pending = updateScalpProtectionRecoveryRecord(record, {
        attemptCount: record.attemptCount + 1,
        lastError: message,
      }, now);
      await save(pending);
      return { status: "emergency-close-pending", blockNewEntries: true, record: pending, message };
    }
    const lastAttemptAt = record.lastAttemptAt ? Date.parse(record.lastAttemptAt) : 0;
    if (Number.isFinite(lastAttemptAt) && nowMs - lastAttemptAt < EMERGENCY_CLOSE_RETRY_MS) {
      return {
        status: "emergency-close-pending",
        blockNewEntries: true,
        record,
        message: "The emergency full close is still pending confirmation; new entries remain blocked.",
      };
    }
    let retryIsDefinitivelySafe = record.emergencyCloseRetryable;
    if (record.emergencyCloseTxid) {
      const inspection = await inspectRecoveryTransaction(dependencies, record.emergencyCloseTxid);
      if (inspection.status !== "failed") {
        const message = transactionPendingMessage(
          "emergency close",
          record.emergencyCloseTxid,
          inspection
        );
        const pending = updateScalpProtectionRecoveryRecord(record, {
          attemptCount: record.attemptCount + 1,
          lastError: message,
        }, now);
        await save(pending);
        return { status: "emergency-close-pending", blockNewEntries: true, record: pending, message };
      }
      retryIsDefinitivelySafe = true;
    }
    if (!retryIsDefinitivelySafe) {
      const message = "The emergency-close submission has no transaction signature or definitive on-chain failure; its outcome is ambiguous, so recovery remains blocked without resubmission.";
      const pending = updateScalpProtectionRecoveryRecord(record, {
        attemptCount: record.attemptCount + 1,
        lastError: message,
      }, now);
      await save(pending);
      return { status: "emergency-close-pending", blockNewEntries: true, record: pending, message };
    }
    const closeReservation = updateScalpProtectionRecoveryRecord(record, {
      status: "emergency-close-submitted",
      emergencyCloseTxid: null,
      emergencyCloseRetryable: false,
      attemptCount: record.attemptCount + 1,
      lastAttemptAt: now,
      lastError: "A retry of the emergency full close is authoritatively reserved and awaiting submission.",
    }, now);
    // This authoritative write is deliberately outside the submission try.
    // If it fails, no external close is attempted and the existing guard
    // continues to block all entries.
    await save(closeReservation);

    let closeTxid: string | null;
    await assertLeaseOwned();
    try {
      closeTxid = await dependencies.emergencyClose(record.positionPubkey, closeReservation);
      if (!closeTxid) {
        throw createScalpEmergencyCloseSubmissionUncertainError(
          new Error("Jupiter did not return an emergency-close transaction signature.")
        );
      }
    } catch (error) {
      const message = `The emergency full close is still required but could not be resubmitted: ${error instanceof Error ? error.message : "close failed"}`;
      const failed = updateScalpProtectionRecoveryRecord(closeReservation, {
        emergencyCloseRetryable: !isScalpProtectionSubmissionUncertainError(error),
        lastError: message,
      }, now);
      await save(failed);
      return { status: "emergency-close-pending", blockNewEntries: true, record: failed, message };
    }

    // If this post-submit write fails, the durable pre-submit reservation is
    // still fresh. A subsequent worker waits for authoritative confirmation
    // instead of immediately duplicating the external close.
    const pending = updateScalpProtectionRecoveryRecord(closeReservation, {
        emergencyCloseTxid: closeTxid,
        emergencyCloseRetryable: false,
        attemptCount: record.attemptCount + 1,
        lastAttemptAt: now,
        lastError: "The prior emergency close remained open, so a full close was resubmitted.",
      }, now);
    await save(pending);
    return {
      status: "emergency-close-pending",
      blockNewEntries: true,
      record: pending,
      message: "The emergency full close was resubmitted; new entries remain blocked until closure is confirmed.",
    };
  }

  const positionBinding = resolveScalpRecoveryPositionBinding(record, snapshot);
  const positionPubkey = positionBinding?.positionPubkey ?? null;
  if (!positionPubkey) {
    if (
      (record.status === "entry-submission-pending" || record.status === "awaiting-position")
      && Number.isFinite(createdAt)
      && nowMs - createdAt >= ENTRY_DISCOVERY_GRACE_MS
      && provesAuthoritativePositionAbsence(snapshot)
    ) {
      const message = "No submitted position appeared during the fail-closed discovery window; the unused pre-entry guard was cleared.";
      await beforeClear("entry-not-found", record, message);
      await clear(record.walletAddress, record.recoveryId);
      return {
        status: "entry-not-found",
        blockNewEntries: true,
        record,
        message,
      };
    }
    const message = record.positionPubkey
      ? "The visible/referenced position cannot be bound to this recovery's entry transaction and execution episode; recovery remains blocked without attaching protection or closing another position."
      : "The submitted scalp position has no execution-bound identity yet; recovery remains armed and new entries are blocked.";
    const pendingStatus = record.status === "entry-submission-pending"
      ? "entry-submission-pending" as const
      : record.status === "protection-submitted"
        ? "protection-submitted" as const
        : "awaiting-position" as const;
    const pending = updateScalpProtectionRecoveryRecord(record, {
      status: pendingStatus,
      attemptCount: record.attemptCount + 1,
      lastAttemptAt: pendingStatus === "protection-submitted" ? record.lastAttemptAt : now,
      lastError: message,
    }, now);
    await save(pending);
    return { status: pendingStatus, blockNewEntries: true, record: pending, message };
  }
  if (!positionBinding) {
    throw new Error("A recovery position pubkey cannot exist without execution-bound identity evidence.");
  }

  const livePosition = findPosition(snapshot, positionPubkey);
  const awaitingProtectionConfirmation = record.status === "protection-submitted";
  const positioned = updateScalpProtectionRecoveryRecord(record, {
    positionPubkey,
    positionIdentitySource: positionBinding.source,
    positionIdentityTxid: positionBinding.entryTxid,
    status: awaitingProtectionConfirmation ? "protection-submitted" : "protection-pending",
    attemptCount: record.attemptCount + 1,
    // A submitted transaction's timestamp is the freshness boundary for the
    // triggers it created. Do not replace it with this snapshot's read time.
    lastAttemptAt: awaitingProtectionConfirmation ? record.lastAttemptAt : now,
  }, now);
  if (livePosition && !matchesRecoveryPositionIdentity(livePosition, positioned)) {
    const message = "The bound position pubkey now resolves to a different side or market episode; recovery remains blocked without submitting TP/SL or an emergency close.";
    const pending = updateScalpProtectionRecoveryRecord(positioned, { lastError: message }, now);
    await save(pending);
    return {
      status: awaitingProtectionConfirmation ? "protection-submitted" : "protection-pending",
      blockNewEntries: true,
      record: pending,
      message,
    };
  }
  const protectionSubmittedAt = record.status === "protection-submitted" && record.lastAttemptAt
    ? Date.parse(record.lastAttemptAt)
    : 0;
  const protectionReservationIsFresh = record.status === "protection-submitted"
    && Number.isFinite(protectionSubmittedAt)
    && nowMs - protectionSubmittedAt < EMERGENCY_CLOSE_RETRY_MS;
  if (!livePosition && protectionReservationIsFresh) {
    const message = "The direct/recovery TP/SL reservation is still fresh and the position is not visible yet; no closure or duplicate submission will be inferred during the propagation window.";
    const pending = updateScalpProtectionRecoveryRecord(positioned, {
      status: "protection-submitted",
      protectionTxid: record.protectionTxid,
      lastError: message,
    }, now);
    await save(pending);
    return {
      status: "protection-submitted",
      blockNewEntries: true,
      record: pending,
      message,
    };
  }
  if (!livePosition && !provesAuthoritativePositionAbsence(snapshot)) {
    const message = "The position is absent from the API response, but an owner-account RPC scan did not verify closure; recovery remains blocked.";
    const pending = updateScalpProtectionRecoveryRecord(positioned, {
      lastError: message,
    }, now);
    await save(pending);
    return {
      status: record.status === "protection-submitted" ? "protection-submitted" : "protection-pending",
      blockNewEntries: true,
      record: pending,
      message,
    };
  }
  if (!livePosition && provesAuthoritativePositionAbsence(snapshot)) {
    const signaturelessDirectIntent = record.status === "protection-submitted"
      && record.protectionTxid === null
      && positionBinding.source === "entry-response";
    if (signaturelessDirectIntent) {
      const inspection = await inspectRecoveryTransaction(dependencies, positionBinding.entryTxid);
      if (inspection.status !== "failed") {
        const message = transactionPendingMessage("entry", positionBinding.entryTxid, inspection);
        const pending = updateScalpProtectionRecoveryRecord(positioned, {
          status: "protection-submitted",
          protectionTxid: null,
          lastError: `${message} The signature-less protection intent therefore remains blocked.`,
        }, now);
        await save(pending);
        return {
          status: "protection-submitted",
          blockNewEntries: true,
          record: pending,
          message: pending.lastError!,
        };
      }
      const message = `Entry transaction ${positionBinding.entryTxid} definitively failed on-chain and the owner-account RPC scan confirms no position; the unused recovery guard was cleared.`;
      await beforeClear("entry-not-found", positioned, message);
      await clear(record.walletAddress, positioned.recoveryId);
      return {
        status: "entry-not-found",
        blockNewEntries: true,
        record: positioned,
        message,
      };
    }
    const message = "The previously submitted scalp position is no longer open, confirmed by the owner-account RPC scan.";
    await beforeClear("position-closed", positioned, message);
    await clear(record.walletAddress, positioned.recoveryId);
    return {
      status: "position-closed",
      blockNewEntries: true,
      record: positioned,
      message,
    };
  }
  if (hasConfirmedScalpRecoveryProtections(snapshot, livePosition, positioned)) {
    const message = "The submitted scalp position has both TP and SL protection confirmed by a fresh Jupiter snapshot; the recovery guard was cleared.";
    await beforeClear("protected", positioned, message);
    await clear(record.walletAddress, positioned.recoveryId);
    return {
      status: "protected",
      blockNewEntries: true,
      record: positioned,
      message,
    };
  }

  if (record.status === "protection-submitted") {
    if (!livePosition || protectionReservationIsFresh) {
      const pending = updateScalpProtectionRecoveryRecord(positioned, {
        status: "protection-submitted",
        protectionTxid: record.protectionTxid,
        lastError: "The TP/SL transaction was submitted but both live triggers are not visible yet.",
      }, now);
      await save(pending);
      return {
        status: "protection-submitted",
        blockNewEntries: true,
        record: pending,
        message: "The TP/SL transaction is awaiting live confirmation; new entries remain blocked.",
      };
    }
    if (record.protectionTxid) {
      const inspection = await inspectRecoveryTransaction(dependencies, record.protectionTxid);
      if (inspection.status !== "failed") {
        const message = transactionPendingMessage("TP/SL", record.protectionTxid, inspection);
        const pending = updateScalpProtectionRecoveryRecord(positioned, {
          status: "protection-submitted",
          protectionTxid: record.protectionTxid,
          lastError: message,
        }, now);
        await save(pending);
        return {
          status: "protection-submitted",
          blockNewEntries: true,
          record: pending,
          message,
        };
      }
    } else if (!record.protectionRetryable) {
      const message = "The TP/SL reservation has no transaction signature or definitive on-chain failure; its outcome is ambiguous, so recovery remains blocked without resubmission or an emergency close.";
      const pending = updateScalpProtectionRecoveryRecord(positioned, {
        status: "protection-submitted",
        protectionTxid: null,
        lastError: message,
      }, now);
      await save(pending);
      return {
        status: "protection-submitted",
        blockNewEntries: true,
        record: pending,
        message,
      };
    }
  }

  const protectionReservation = updateScalpProtectionRecoveryRecord(positioned, {
    status: "protection-submitted",
    protectionTxid: null,
    protectionRetryable: false,
    lastAttemptAt: now,
    lastError: "A full-position TP/SL submission is authoritatively reserved and awaiting submission.",
  }, now);
  // Never call Jupiter unless the side-effect intent is durable first. This
  // reservation also supplies the retry/freshness boundary if the transaction
  // succeeds but the follow-up txid write fails.
  await save(protectionReservation);

  let protectionSubmission: ScalpProtectionSubmission | null;
  await assertLeaseOwned();
  try {
    protectionSubmission = await dependencies.attachProtection(positionPubkey, protectionReservation);
    const protectionTxid = typeof protectionSubmission === "string"
      ? protectionSubmission
      : protectionSubmission?.txid ?? null;
    if (!protectionTxid) {
      throw createScalpProtectionSubmissionUncertainError(
        new Error("Jupiter returned no TP/SL transaction signature.")
      );
    }
  } catch (protectionError) {
    const protectionMessage = protectionError instanceof Error
      ? protectionError.message
      : "Unable to attach both scalp protections.";

    if (isScalpProtectionSubmissionUncertainError(protectionError)) {
      const pending = updateScalpProtectionRecoveryRecord(protectionReservation, {
        protectionRetryable: false,
        lastError: `${protectionMessage} Recovery will inspect live triggers before any retry or emergency close.`,
      }, now);
      await save(pending);
      return {
        status: "protection-submitted",
        blockNewEntries: true,
        record: pending,
        message: "The TP/SL submission result is uncertain; no duplicate transaction or emergency close will be sent until authoritative recovery inspects the live position.",
      };
    }

    const closeReservation = updateScalpProtectionRecoveryRecord(protectionReservation, {
      status: "emergency-close-submitted",
      emergencyCloseTxid: null,
      emergencyCloseRetryable: false,
      attemptCount: protectionReservation.attemptCount + 1,
      lastAttemptAt: now,
      lastError: `TP/SL attachment failed (${protectionMessage}); an emergency full close is authoritatively reserved.`,
    }, now);
    // As with protection, a close is never sent unless its intent is durable.
    await save(closeReservation);

    let closeTxid: string | null;
    await assertLeaseOwned();
    try {
      closeTxid = await dependencies.emergencyClose(positionPubkey, closeReservation);
      if (!closeTxid) {
        throw createScalpEmergencyCloseSubmissionUncertainError(
          new Error("Jupiter did not return an emergency-close transaction signature.")
        );
      }
    } catch (closeError) {
      const message = `TP/SL attachment failed (${protectionMessage}) and emergency close failed (${closeError instanceof Error ? closeError.message : "close failed"}).`;
      const pending = updateScalpProtectionRecoveryRecord(closeReservation, {
        emergencyCloseRetryable: !isScalpProtectionSubmissionUncertainError(closeError),
        lastError: message,
      }, now);
      await save(pending);
      return { status: "emergency-close-pending", blockNewEntries: true, record: pending, message };
    }

    const pending = updateScalpProtectionRecoveryRecord(closeReservation, {
      emergencyCloseTxid: closeTxid,
      emergencyCloseRetryable: false,
      lastError: `TP/SL attachment failed (${protectionMessage}); emergency full close submitted.`,
    }, now);
    await save(pending);
    return {
      status: "emergency-close-pending",
      blockNewEntries: true,
      record: pending,
      message: `TP/SL attachment failed; emergency full close ${closeTxid} is pending confirmation.`,
    };
  }

  const protectionTxid = typeof protectionSubmission === "string"
    ? protectionSubmission
    : protectionSubmission?.txid ?? null;
  if (!protectionTxid) {
    // The null case is rejected above; retain a total guard for TypeScript and
    // future callback implementations without weakening fail-closed behavior.
    throw new Error("Jupiter did not return a TP/SL transaction signature.");
  }
  const pending = updateScalpProtectionRecoveryRecord(protectionReservation, {
    protectionTxid,
    protectionRetryable: false,
    expectedTakeProfitPrice: typeof protectionSubmission === "object"
      ? protectionSubmission?.takeProfitPrice ?? protectionReservation.expectedTakeProfitPrice
      : protectionReservation.expectedTakeProfitPrice,
    expectedStopLossPrice: typeof protectionSubmission === "object"
      ? protectionSubmission?.stopLossPrice ?? protectionReservation.expectedStopLossPrice
      : protectionReservation.expectedStopLossPrice,
    lastError: "The TP/SL transaction was submitted and is awaiting confirmation of both live triggers.",
  }, now);
  await save(pending);
  return {
    status: "protection-submitted",
    blockNewEntries: true,
    record: pending,
    message: `The TP/SL transaction ${protectionTxid} was submitted; the recovery guard remains until both triggers are visible.`,
  };
}

export async function runScalpProtectionRecovery(
  record: ScalpProtectionRecoveryRecord,
  dependencies: ScalpProtectionRecoveryDependencies
): Promise<ScalpProtectionRecoveryResult> {
  const withLease = dependencies.withRecoveryLease ?? withScalpProtectionRecoveryLease;
  return withLease(record, (assertLeaseOwned) => (
    runScalpProtectionRecoveryUnlocked(record, dependencies, assertLeaseOwned)
  ));
}
