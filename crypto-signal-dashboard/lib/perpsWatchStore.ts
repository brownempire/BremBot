import fs from "node:fs";

import { getRedisClient } from "@/lib/server/redis";
import type { JupiterPerpsAccountSnapshot } from "@/lib/jupiterPerps";

export type StoredPerpsWatchState = {
  walletAddress: string;
  monitoredWalletAddress?: string;
  lastCheckedAt: number;
  snapshot: JupiterPerpsAccountSnapshot;
};

const STORE_FILE_PATH = process.env.PERPS_WATCH_STATE_FILE || "/tmp/brembot-perps-watch-state.json";
const REDIS_PERPS_WATCH_KEY = "brembot:perps:watch-state";

function readStore(): StoredPerpsWatchState[] {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return [];
    const raw = fs.readFileSync(STORE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StoredPerpsWatchState[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(entries: StoredPerpsWatchState[]) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(entries), "utf8");
  } catch {
    // Keep watcher non-fatal in restricted environments.
  }
}

async function readRedisStore() {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const values = await client.hVals(REDIS_PERPS_WATCH_KEY);
  return values
    .map((value) => {
      try {
        return JSON.parse(value) as StoredPerpsWatchState;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is StoredPerpsWatchState => Boolean(entry?.walletAddress));
}

async function writeRedisStore(entries: StoredPerpsWatchState[]) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  const multi = client.multi();
  entries.forEach((entry) => {
    multi.hSet(REDIS_PERPS_WATCH_KEY, entry.walletAddress, JSON.stringify(entry));
  });
  await multi.exec();
  return true;
}

export async function listPerpsWatchStates() {
  const redisEntries = await readRedisStore();
  return redisEntries ?? readStore();
}

export async function getPerpsWatchState(walletAddress: string) {
  const states = await listPerpsWatchStates();
  return states.find((entry) => entry.walletAddress === walletAddress) ?? null;
}

export async function savePerpsWatchState(entry: StoredPerpsWatchState) {
  const states = await listPerpsWatchStates();
  const next = [
    entry,
    ...states.filter((state) => state.walletAddress !== entry.walletAddress),
  ];
  const wroteRedis = await writeRedisStore(next);
  if (!wroteRedis) writeStore(next);
  return entry;
}
