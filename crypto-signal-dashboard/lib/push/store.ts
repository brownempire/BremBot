import fs from "node:fs";
import { getRedisClient } from "@/lib/server/redis";

export type PushSubscriptionRecord = PushSubscriptionJSON & { id: string };

const STORE_FILE_PATH = process.env.PUSH_SUBSCRIPTIONS_FILE || "/tmp/brembot-push-subscriptions.json";
const REDIS_SUBSCRIPTIONS_KEY = "brembot:push:subscriptions";

function readStore(): PushSubscriptionRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return [];
    const raw = fs.readFileSync(STORE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PushSubscriptionRecord => {
      return typeof entry?.endpoint === "string" && typeof entry?.id === "string";
    });
  } catch {
    return [];
  }
}

function writeStore(subscriptions: PushSubscriptionRecord[]) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(subscriptions), "utf8");
  } catch {
    // Ignore write failures to avoid breaking API routes in restricted environments.
  }
}

async function readRedisStore(): Promise<PushSubscriptionRecord[] | null> {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const entries = await client.hVals(REDIS_SUBSCRIPTIONS_KEY);
  return entries
    .map((entry) => {
      try {
        return JSON.parse(entry) as PushSubscriptionRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is PushSubscriptionRecord => !!entry?.endpoint && !!entry.id);
}

async function writeRedisEntry(record: PushSubscriptionRecord) {
  const client = await getRedisClient().catch(() => null);
  if (!client || !record.endpoint) return false;
  await client.hSet(REDIS_SUBSCRIPTIONS_KEY, String(record.endpoint), JSON.stringify(record));
  return true;
}

async function deleteRedisEntry(endpoint: string) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  await client.hDel(REDIS_SUBSCRIPTIONS_KEY, endpoint);
  return true;
}

export async function addSubscription(sub: PushSubscriptionJSON) {
  const redisSubscriptions = await readRedisStore();
  const subscriptions = redisSubscriptions ?? readStore();
  const id = sub.endpoint ?? String(Date.now());
  if (subscriptions.some((existing) => existing.endpoint === sub.endpoint)) {
    return subscriptions;
  }
  const record = { ...sub, id };
  const next = [...subscriptions, record];
  const wroteRedis = await writeRedisEntry(record);
  if (!wroteRedis) writeStore(next);
  return next;
}

export async function removeSubscription(endpoint: string) {
  const redisSubscriptions = await readRedisStore();
  const subscriptions = redisSubscriptions ?? readStore();
  const next = subscriptions.filter((existing) => existing.endpoint !== endpoint);
  const deletedRedis = await deleteRedisEntry(endpoint);
  if (!deletedRedis) writeStore(next);
  return next;
}

export async function listSubscriptions() {
  const redisSubscriptions = await readRedisStore();
  if (redisSubscriptions) return redisSubscriptions;
  return readStore();
}
