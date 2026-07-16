import fs from "node:fs";

import { getRedisClient } from "@/lib/server/redis";
import { perpsUserExecutionSchema, type PerpsUserExecution } from "@/lib/perps/sessionTypes";

const STORE_FILE_PATH = process.env.PERPS_USER_EXECUTIONS_FILE || "/tmp/brembot-perps-user-executions.json";
const FEED_STATE_FILE_PATH = process.env.PERPS_USER_EXECUTION_FEED_STATE_FILE || "/tmp/brembot-perps-user-execution-feed-state.json";
const REDIS_KEY = "brembot:perps:user-executions";
const FEED_STATE_REDIS_KEY = "brembot:perps:user-execution-feed-state";
const MAX_EXECUTIONS_PER_WALLET = 100;

type UserExecutionMap = Record<string, PerpsUserExecution[]>;
type UserExecutionFeedStateMap = Record<string, string>;

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
    const value = await client.hGet(FEED_STATE_REDIS_KEY, walletAddress);
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  }
  return readFeedStateDisk()[walletAddress] ?? null;
}

async function readRedisStore() {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const raw = await client.get(REDIS_KEY);
  return raw ? parseExecutionMap(raw) : {};
}

async function writeRedisStore(store: UserExecutionMap) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  await client.set(REDIS_KEY, JSON.stringify(store));
  return true;
}

async function readStore() {
  return (await readRedisStore()) ?? readDiskStore();
}

async function writeStore(store: UserExecutionMap) {
  const wroteRedis = await writeRedisStore(store);
  if (!wroteRedis) writeDiskStore(store);
}

export async function listUserPerpsExecutions(walletAddress: string) {
  const store = await readStore();
  return (store[walletAddress] ?? []).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
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
    await client.hSet(FEED_STATE_REDIS_KEY, walletAddress, clearedBefore);
  } else {
    const store = readFeedStateDisk();
    store[walletAddress] = clearedBefore;
    writeFeedStateDisk(store);
  }
  return clearedBefore;
}

export async function createUserPerpsExecution(record: PerpsUserExecution) {
  const store = await readStore();
  const next = [record, ...(store[record.walletAddress] ?? []).filter((item) => item.executionId !== record.executionId)]
    .slice(0, MAX_EXECUTIONS_PER_WALLET);
  store[record.walletAddress] = next;
  await writeStore(store);
  return record;
}

export async function updateUserPerpsExecution(walletAddress: string, executionId: string, patch: Partial<PerpsUserExecution>) {
  const store = await readStore();
  const current = store[walletAddress] ?? [];
  const next = current.map((entry) => (
    entry.executionId === executionId
      ? perpsUserExecutionSchema.parse({ ...entry, ...patch, updatedAt: new Date().toISOString() })
      : entry
  ));
  store[walletAddress] = next;
  await writeStore(store);
  return next.find((entry) => entry.executionId === executionId) ?? null;
}

export async function reconcileUserExecutionsWithoutOpenPosition(walletAddress: string) {
  const store = await readStore();
  const current = store[walletAddress] ?? [];
  let changed = false;
  const now = new Date().toISOString();
  const next = current.map((entry) => {
    if (!["prepared", "submitted", "confirmed"].includes(entry.status)) return entry;
    changed = true;
    return perpsUserExecutionSchema.parse({
      ...entry,
      status: "cancelled",
      reasonCode: "POSITION_CLOSED",
      reasonMessage: "No matching open agent position remains on Jupiter Perps.",
      updatedAt: now,
    });
  });
  if (!changed) return current;
  store[walletAddress] = next;
  await writeStore(store);
  return next;
}
