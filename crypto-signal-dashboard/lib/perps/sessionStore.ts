import fs from "node:fs";

import { getRedisClient } from "@/lib/server/redis";
import { perpsAutomationSessionSchema, type PerpsAutomationSession } from "@/lib/perps/sessionTypes";

const STORE_FILE_PATH = process.env.PERPS_SESSIONS_FILE || "/tmp/brembot-perps-sessions.json";
const REDIS_KEY = "brembot:perps:sessions";

function readDiskStore() {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return [];
    const raw = fs.readFileSync(STORE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed)
      ? parsed.flatMap((entry) => {
          const result = perpsAutomationSessionSchema.safeParse(entry);
          return result.success ? [result.data] : [];
        })
      : [];
  } catch {
    return [];
  }
}

function writeDiskStore(sessions: PerpsAutomationSession[]) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(sessions), "utf8");
  } catch {
    // ignore fallback write failures
  }
}

async function readRedisStore() {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const entries = await client.hVals(REDIS_KEY);
  return entries.flatMap((entry) => {
    try {
      const parsed = JSON.parse(entry);
      const result = perpsAutomationSessionSchema.safeParse(parsed);
      return result.success ? [result.data] : [];
    } catch {
      return [];
    }
  });
}

async function writeRedisStore(sessions: PerpsAutomationSession[]) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  const multi = client.multi();
  multi.del(REDIS_KEY);
  sessions.forEach((session) => {
    multi.hSet(REDIS_KEY, session.walletAddress, JSON.stringify(session));
  });
  await multi.exec();
  return true;
}

export async function listPerpsSessions() {
  return (await readRedisStore()) ?? readDiskStore();
}

export async function getPerpsSession(walletAddress: string) {
  const sessions = await listPerpsSessions();
  return sessions.find((session) => session.walletAddress === walletAddress) ?? null;
}

export async function savePerpsSession(session: PerpsAutomationSession) {
  const sessions = await listPerpsSessions();
  const next = [session, ...sessions.filter((item) => item.walletAddress !== session.walletAddress)];
  const wroteRedis = await writeRedisStore(next);
  if (!wroteRedis) writeDiskStore(next);
  return session;
}
