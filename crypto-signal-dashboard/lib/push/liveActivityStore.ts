import { getRedisClient } from "@/lib/server/redis";

export type LiveActivityPushTokenRecord = {
  token: string;
  positionKey: string;
  createdAt: number;
  updatedAt: number;
};

const REDIS_TOKEN_KEY = "brembot:push:live-activity-tokens";
const REDIS_DISPATCH_LOCK_KEY = "brembot:push:live-activity-dispatch-lock";

export function isValidLiveActivityToken(token: string) {
  return /^[a-f0-9]{64,512}$/i.test(token);
}

export function isValidLiveActivityPositionKey(positionKey: string) {
  return /^[A-Z0-9_.-]{3,128}$/.test(positionKey);
}

export async function addLiveActivityPushToken(input: {
  token: string;
  positionKey: string;
}) {
  const token = input.token.trim().toLowerCase();
  const positionKey = input.positionKey.trim().toUpperCase();
  if (!isValidLiveActivityToken(token) || !isValidLiveActivityPositionKey(positionKey)) {
    throw new Error("Invalid Live Activity registration");
  }

  const client = await getRedisClient();
  if (!client) {
    throw new Error("Redis is required for Live Activity registration");
  }

  const existingRaw = await client.hGet(REDIS_TOKEN_KEY, token);
  const now = Date.now();
  let createdAt = now;
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as Partial<LiveActivityPushTokenRecord>;
      if (typeof existing.createdAt === "number" && Number.isFinite(existing.createdAt)) {
        createdAt = existing.createdAt;
      }
    } catch {
      // Replace malformed records.
    }
  }

  const record: LiveActivityPushTokenRecord = {
    token,
    positionKey,
    createdAt,
    updatedAt: now,
  };
  await client.hSet(REDIS_TOKEN_KEY, token, JSON.stringify(record));
  return record;
}

export async function listLiveActivityPushTokens() {
  const client = await getRedisClient();
  if (!client) return [];

  const entries = await client.hVals(REDIS_TOKEN_KEY);
  return entries.flatMap((entry) => {
    try {
      const record = JSON.parse(entry) as LiveActivityPushTokenRecord;
      return isValidLiveActivityToken(record.token)
        && isValidLiveActivityPositionKey(record.positionKey)
        ? [record]
        : [];
    } catch {
      return [];
    }
  });
}

export async function removeLiveActivityPushToken(token: string) {
  const client = await getRedisClient();
  if (!client) return;
  await client.hDel(REDIS_TOKEN_KEY, token.trim().toLowerCase());
}

export async function claimLiveActivityDispatchWindow(
  now = Date.now(),
  intervalMs = 5 * 60_000
) {
  const client = await getRedisClient();
  if (!client) return false;

  const result = await client.set(REDIS_DISPATCH_LOCK_KEY, String(now), {
    NX: true,
    PX: intervalMs,
  });
  return result === "OK";
}
