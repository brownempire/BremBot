import fs from "node:fs";

import { getRedisClient } from "@/lib/server/redis";
import { perpsUserExecutionSchema, type PerpsUserExecution } from "@/lib/perps/sessionTypes";

const STORE_FILE_PATH = process.env.PERPS_USER_EXECUTIONS_FILE || "/tmp/brembot-perps-user-executions.json";
const FEED_STATE_FILE_PATH = process.env.PERPS_USER_EXECUTION_FEED_STATE_FILE || "/tmp/brembot-perps-user-execution-feed-state.json";
const REDIS_KEY = "brembot:perps:user-executions";
const REDIS_RECORDS_KEY = "brembot:perps:user-execution-records:v2";
const FEED_STATE_REDIS_KEY = "brembot:perps:user-execution-feed-state";

type UserExecutionMap = Record<string, PerpsUserExecution[]>;
type UserExecutionFeedStateMap = Record<string, string>;
type ExecutionAuditMigrationClient = {
  hSetNX: (key: string, field: string, value: string) => Promise<boolean | number>;
};

function executionRecordField(record: Pick<PerpsUserExecution, "walletAddress" | "executionId">) {
  return `${record.walletAddress}:${record.executionId}`;
}

export async function migrateMissingUserExecutionRecordsToRedis(
  client: ExecutionAuditMigrationClient,
  diskRecords: readonly PerpsUserExecution[],
  authoritativeRecords: readonly PerpsUserExecution[]
) {
  const authoritativeFields = new Set(authoritativeRecords.map(executionRecordField));
  for (const record of diskRecords) {
    const field = executionRecordField(record);
    if (authoritativeFields.has(field)) continue;
    await client.hSetNX(REDIS_RECORDS_KEY, field, JSON.stringify(record));
    authoritativeFields.add(field);
  }
}

function parseExecutionMap(raw: string) {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown[]>;
    const result: UserExecutionMap = {};
    Object.entries(parsed).forEach(([wallet, entries]) => {
      result[wallet] = Array.isArray(entries)
        ? entries.flatMap((entry) => {
            const item = perpsUserExecutionSchema.safeParse(entry);
            return item.success ? [item.data] : [];
          })
        : [];
    });
    return result;
  } catch {
    return {};
  }
}

function readDiskStore() {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return {};
    return parseExecutionMap(fs.readFileSync(STORE_FILE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeDiskStore(store: UserExecutionMap) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(store), "utf8");
  } catch {
    // ignore
  }
}

function readFeedStateDisk(): UserExecutionFeedStateMap {
  try {
    if (!fs.existsSync(FEED_STATE_FILE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(FEED_STATE_FILE_PATH, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1]))
      ))
    );
  } catch {
    return {};
  }
}

function writeFeedStateDisk(store: UserExecutionFeedStateMap) {
  try {
    fs.writeFileSync(FEED_STATE_FILE_PATH, JSON.stringify(store), "utf8");
  } catch {
    // ignore
  }
}

async function getExecutionFeedClearedBefore(walletAddress: string) {
  const client = await getRedisClient().catch(() => null);
  if (client) {
    try {
      const value = await client.hGet(FEED_STATE_REDIS_KEY, walletAddress);
      return value && Number.isFinite(Date.parse(value)) ? value : null;
    } catch {
      // Fall through to the local fail-safe when Redis is temporarily unavailable.
    }
  }
  return readFeedStateDisk()[walletAddress] ?? null;
}

async function readRedisStore() {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  let legacyRaw: string | null;
  let recordValues: string[];
  try {
    [legacyRaw, recordValues] = await Promise.all([
      client.get(REDIS_KEY),
      client.hVals(REDIS_RECORDS_KEY),
    ]);
  } catch {
    return null;
  }
  const merged = legacyRaw ? parseExecutionMap(legacyRaw) : {};

  for (const value of recordValues) {
    try {
      const parsed = perpsUserExecutionSchema.safeParse(JSON.parse(value));
      if (!parsed.success) continue;
      const record = parsed.data;
      const current = merged[record.walletAddress] ?? [];
      merged[record.walletAddress] = [
        record,
        ...current.filter((entry) => entry.executionId !== record.executionId),
      ];
    } catch {
      // Ignore malformed historical values without discarding valid records.
    }
  }

  return merged;
}

async function readRedisStoreAuthoritative() {
  const client = await getRedisClient().catch(() => null);
  if (!client) throw new Error("Authoritative Redis execution audit is unavailable; live scalp admission is blocked.");
  let legacyRaw: string | null;
  let recordValues: string[];
  try {
    [legacyRaw, recordValues] = await Promise.all([
      client.get(REDIS_KEY),
      client.hVals(REDIS_RECORDS_KEY),
    ]);
  } catch (error) {
    throw new Error(
      `Authoritative Redis execution audit could not be read: ${error instanceof Error ? error.message : "unknown Redis error"}`
    );
  }

  const merged: UserExecutionMap = {};
  if (legacyRaw) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(legacyRaw);
    } catch {
      throw new Error("The authoritative legacy execution audit contains malformed JSON.");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("The authoritative legacy execution audit failed schema validation.");
    }
    for (const [walletAddress, entries] of Object.entries(decoded)) {
      if (!Array.isArray(entries)) throw new Error("The authoritative legacy execution audit failed schema validation.");
      merged[walletAddress] = entries.map((entry) => perpsUserExecutionSchema.parse(entry));
    }
  }
  for (const value of recordValues) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error("An authoritative Redis execution record contains malformed JSON.");
    }
    const record = perpsUserExecutionSchema.parse(decoded);
    const current = merged[record.walletAddress] ?? [];
    merged[record.walletAddress] = [
      record,
      ...current.filter((entry) => entry.executionId !== record.executionId),
    ];
  }
  return merged;
}

function normalizeAndSortExecutions(entries: PerpsUserExecution[]) {
  return entries
    .map((entry) => (
      entry.status === "cancelled"
      && entry.reasonCode === "POSITION_CLOSED"
      && Boolean(entry.txid || entry.positionPubkey)
        ? perpsUserExecutionSchema.parse({
            ...entry,
            status: "closed",
            reasonMessage: "Trade completed and no matching open position remains on Jupiter Perps.",
          })
        : entry
    ))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function readStore() {
  const diskStore = readDiskStore();
  const redisStore = await readRedisStore();
  if (!redisStore) return diskStore;

  const merged: UserExecutionMap = { ...diskStore };
  Object.entries(redisStore).forEach(([walletAddress, records]) => {
    const byId = new Map<string, PerpsUserExecution>();
    (diskStore[walletAddress] ?? []).forEach((record) => byId.set(record.executionId, record));
    records.forEach((record) => byId.set(record.executionId, record));
    merged[walletAddress] = [...byId.values()];
  });

  const diskRecords = Object.values(diskStore).flat();
  if (diskRecords.length > 0) {
    const client = await getRedisClient().catch(() => null);
    if (client) {
      try {
        await migrateMissingUserExecutionRecordsToRedis(
          client,
          diskRecords,
          Object.values(redisStore).flat()
        );
      } catch {
        // A later read retries missing fallback records; authoritative Redis values always win.
      }
    }
  }
  return merged;
}

async function writeRedisRecords(records: PerpsUserExecution[]) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  try {
    const multi = client.multi();
    records.forEach((record) => {
      multi.hSet(REDIS_RECORDS_KEY, `${record.walletAddress}:${record.executionId}`, JSON.stringify(record));
    });
    await multi.exec();
    return true;
  } catch {
    return false;
  }
}

export async function listUserPerpsExecutions(walletAddress: string) {
  const store = await readStore();
  return normalizeAndSortExecutions(store[walletAddress] ?? []);
}

export async function listUserPerpsExecutionsAuthoritative(walletAddress: string) {
  const store = await readRedisStoreAuthoritative();
  return normalizeAndSortExecutions(store[walletAddress] ?? []);
}

export async function listVisibleUserPerpsExecutions(walletAddress: string) {
  const [executions, clearedBefore] = await Promise.all([
    listUserPerpsExecutions(walletAddress),
    getExecutionFeedClearedBefore(walletAddress),
  ]);
  if (!clearedBefore) return executions;
  const cutoff = Date.parse(clearedBefore);
  return executions.filter((entry) => Date.parse(entry.createdAt) > cutoff);
}

export async function clearUserPerpsExecutionFeed(walletAddress: string) {
  const clearedBefore = new Date().toISOString();
  const client = await getRedisClient().catch(() => null);
  if (client) {
    try {
      await client.hSet(FEED_STATE_REDIS_KEY, walletAddress, clearedBefore);
      return clearedBefore;
    } catch {
      // Preserve the UI-only clear marker locally if Redis is interrupted.
    }
  }
  const store = readFeedStateDisk();
  store[walletAddress] = clearedBefore;
  writeFeedStateDisk(store);
  return clearedBefore;
}

export async function createUserPerpsExecution(
  record: PerpsUserExecution,
  options: { requireAuthoritative?: boolean } = {}
) {
  const wroteRedis = await writeRedisRecords([record]);
  if (!wroteRedis) {
    if (options.requireAuthoritative) {
      throw new Error("Authoritative Redis execution audit is unavailable; live scalp submission is blocked.");
    }
    const store = readDiskStore();
    store[record.walletAddress] = [
      record,
      ...(store[record.walletAddress] ?? []).filter((item) => item.executionId !== record.executionId),
    ];
    writeDiskStore(store);
  }
  return record;
}

export async function updateUserPerpsExecution(
  walletAddress: string,
  executionId: string,
  patch: Partial<PerpsUserExecution>,
  options: { requireAuthoritative?: boolean } = {}
) {
  const current = options.requireAuthoritative
    ? await listUserPerpsExecutionsAuthoritative(walletAddress)
    : await listUserPerpsExecutions(walletAddress);
  const existing = current.find((entry) => entry.executionId === executionId);
  if (!existing) return null;
  const updated = perpsUserExecutionSchema.parse({ ...existing, ...patch, updatedAt: new Date().toISOString() });
  const wroteRedis = await writeRedisRecords([updated]);
  if (!wroteRedis) {
    if (options.requireAuthoritative) {
      throw new Error("Authoritative Redis execution audit is unavailable; scalp recovery remains blocked.");
    }
    const store = readDiskStore();
    store[walletAddress] = [
      updated,
      ...(store[walletAddress] ?? []).filter((entry) => entry.executionId !== executionId),
    ];
    writeDiskStore(store);
  }
  return updated;
}

export async function reconcileUserExecutionsWithoutOpenPosition(walletAddress: string) {
  const store = await readStore();
  const current = store[walletAddress] ?? [];
  let changed = false;
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const next = current.map((entry) => {
    if (!["prepared", "submitted", "confirmed"].includes(entry.status)) return entry;
    if (nowMs - Date.parse(entry.updatedAt) < 2 * 60_000) return entry;
    changed = true;
    const completed = entry.status === "confirmed" || Boolean(entry.txid || entry.positionPubkey);
    return perpsUserExecutionSchema.parse({
      ...entry,
      status: completed ? "closed" : "cancelled",
      reasonCode: "POSITION_CLOSED",
      reasonMessage: completed
        ? "Trade completed and no matching open position remains on Jupiter Perps."
        : "The prepared order expired without a matching Jupiter Perps position.",
      updatedAt: now,
    });
  });
  if (!changed) return current;
  const changedRecords = next.filter((entry, index) => entry !== current[index]);
  const wroteRedis = await writeRedisRecords(changedRecords);
  if (!wroteRedis) {
    store[walletAddress] = next;
    writeDiskStore(store);
  }
  return next;
}
