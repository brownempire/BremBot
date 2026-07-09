import fs from "node:fs";

import { getRedisClient } from "@/lib/server/redis";
import { perpsUserExecutionSchema, type PerpsUserExecution } from "@/lib/perps/sessionTypes";

const STORE_FILE_PATH = process.env.PERPS_USER_EXECUTIONS_FILE || "/tmp/brembot-perps-user-executions.json";
const REDIS_KEY = "brembot:perps:user-executions";
const MAX_EXECUTIONS_PER_WALLET = 100;

type UserExecutionMap = Record<string, PerpsUserExecution[]>;

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
