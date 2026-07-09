import fs from "node:fs";

import { getRedisClient } from "@/lib/server/redis";
import { perpsExecutionRecordSchema, type PerpsExecutionRecord } from "@/lib/perps/types";

type PerpsRuntimeState = {
  killSwitchOverride: boolean | null;
  updatedAt: string;
};

const EXECUTIONS_FILE_PATH = process.env.PERPS_EXECUTIONS_FILE || "/tmp/brembot-perps-executions.json";
const RUNTIME_FILE_PATH = process.env.PERPS_RUNTIME_FILE || "/tmp/brembot-perps-runtime.json";
const EXECUTIONS_REDIS_KEY = "brembot:perps:executions";
const RUNTIME_REDIS_KEY = "brembot:perps:runtime";
const MAX_EXECUTIONS = 200;

function readExecutionsFromDisk() {
  try {
    if (!fs.existsSync(EXECUTIONS_FILE_PATH)) return [];
    const raw = fs.readFileSync(EXECUTIONS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed)
      ? parsed.flatMap((entry) => {
          const result = perpsExecutionRecordSchema.safeParse(entry);
          return result.success ? [result.data] : [];
        })
      : [];
  } catch {
    return [];
  }
}

function writeExecutionsToDisk(records: PerpsExecutionRecord[]) {
  try {
    fs.writeFileSync(EXECUTIONS_FILE_PATH, JSON.stringify(records), "utf8");
  } catch {
    // ignore fallback write failures
  }
}

function readRuntimeFromDisk(): PerpsRuntimeState {
  try {
    if (!fs.existsSync(RUNTIME_FILE_PATH)) {
      return { killSwitchOverride: null, updatedAt: new Date(0).toISOString() };
    }
    const raw = fs.readFileSync(RUNTIME_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PerpsRuntimeState>;
    return {
      killSwitchOverride: typeof parsed.killSwitchOverride === "boolean" ? parsed.killSwitchOverride : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return { killSwitchOverride: null, updatedAt: new Date(0).toISOString() };
  }
}

function writeRuntimeToDisk(state: PerpsRuntimeState) {
  try {
    fs.writeFileSync(RUNTIME_FILE_PATH, JSON.stringify(state), "utf8");
  } catch {
    // ignore fallback write failures
  }
}

async function readExecutionsFromRedis() {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const entries = await client.hVals(EXECUTIONS_REDIS_KEY);
  return entries.flatMap((entry) => {
    try {
      const parsed = JSON.parse(entry);
      const result = perpsExecutionRecordSchema.safeParse(parsed);
      return result.success ? [result.data] : [];
    } catch {
      return [];
    }
  });
}

async function writeExecutionsToRedis(records: PerpsExecutionRecord[]) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  const multi = client.multi();
  multi.del(EXECUTIONS_REDIS_KEY);
  records.forEach((record) => {
    multi.hSet(EXECUTIONS_REDIS_KEY, record.id, JSON.stringify(record));
  });
  await multi.exec();
  return true;
}

async function readRuntimeFromRedis() {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const raw = await client.get(RUNTIME_REDIS_KEY);
  if (!raw) return { killSwitchOverride: null, updatedAt: new Date(0).toISOString() };
  try {
    const parsed = JSON.parse(raw) as Partial<PerpsRuntimeState>;
    return {
      killSwitchOverride: typeof parsed.killSwitchOverride === "boolean" ? parsed.killSwitchOverride : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return { killSwitchOverride: null, updatedAt: new Date(0).toISOString() };
  }
}

async function writeRuntimeToRedis(state: PerpsRuntimeState) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  await client.set(RUNTIME_REDIS_KEY, JSON.stringify(state));
  return true;
}

export async function listPerpsExecutions() {
  const redisRecords = await readExecutionsFromRedis();
  const records = redisRecords ?? readExecutionsFromDisk();
  return records.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export async function createPerpsExecution(record: PerpsExecutionRecord) {
  const records = await listPerpsExecutions();
  const next = [record, ...records].slice(0, MAX_EXECUTIONS);
  const wroteRedis = await writeExecutionsToRedis(next);
  if (!wroteRedis) writeExecutionsToDisk(next);
  return record;
}

export async function updatePerpsExecution(id: string, patch: Partial<PerpsExecutionRecord>) {
  const records = await listPerpsExecutions();
  const next = records.map((record) => {
    if (record.id !== id) return record;
    return perpsExecutionRecordSchema.parse({
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  });
  const updated = next.find((record) => record.id === id) ?? null;
  const wroteRedis = await writeExecutionsToRedis(next);
  if (!wroteRedis) writeExecutionsToDisk(next);
  return updated;
}

export async function getPerpsExecutionBySignalId(signalId: string) {
  const records = await listPerpsExecutions();
  return records.find((record) => record.signalId === signalId) ?? null;
}

export async function getPerpsRuntimeOverride() {
  const redisState = await readRuntimeFromRedis();
  return redisState ?? readRuntimeFromDisk();
}

export async function setPerpsKillSwitchOverride(enabled: boolean | null) {
  const nextState: PerpsRuntimeState = {
    killSwitchOverride: enabled,
    updatedAt: new Date().toISOString(),
  };
  const wroteRedis = await writeRuntimeToRedis(nextState);
  if (!wroteRedis) writeRuntimeToDisk(nextState);
  return nextState;
}
