import { perpsAutomationConfigSchema, type PerpsAutomationConfig } from "@/lib/perps/automationConfig";
import { getRedisClient } from "@/lib/server/redis";

const REDIS_KEY = "brembot:perps:automation-configs";

async function requireRedis() {
  const redis = await getRedisClient();
  if (!redis) {
    throw new Error("Redis is required for autonomous Perps configuration.");
  }
  return redis;
}
function parseConfig(value: string | null) {
  if (!value) return null;
  try {
    const parsed = perpsAutomationConfigSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getPerpsAutomationConfig(walletAddress: string) {
  const redis = await requireRedis();
  return parseConfig(await redis.hGet(REDIS_KEY, walletAddress));
}

export async function listPerpsAutomationConfigs() {
  const redis = await requireRedis();
  const entries = await redis.hVals(REDIS_KEY);
  return entries.flatMap((entry) => {
    const parsed = parseConfig(entry);
    return parsed ? [parsed] : [];
  });
}

export async function savePerpsAutomationConfig(config: PerpsAutomationConfig) {
  const parsed = perpsAutomationConfigSchema.parse(config);
  const redis = await requireRedis();
  await redis.hSet(REDIS_KEY, parsed.walletAddress, JSON.stringify(parsed));
  return parsed;
}

export async function deletePerpsAutomationConfig(walletAddress: string) {
  const redis = await requireRedis();
  await redis.hDel(REDIS_KEY, walletAddress);
}
