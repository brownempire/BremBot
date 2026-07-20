import { perpsAutomationConfigSchema, type PerpsAutomationConfig } from "@/lib/perps/automationConfig";
import { getRedisClient } from "@/lib/server/redis";

const REDIS_KEY = "brembot:perps:automation-configs";

const SAVE_CONFIG_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
local expectedRevision = tonumber(ARGV[2])
local currentRevision = 0

if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok then
    currentRevision = tonumber(decoded.revision) or 1
  else
    currentRevision = 1
  end
end

if currentRevision ~= expectedRevision then
  return {0, current or ''}
end

local nextConfig = cjson.decode(ARGV[3])
nextConfig.revision = currentRevision + 1
local encoded = cjson.encode(nextConfig)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return {1, encoded}
`;

const DISABLE_SCALP_MODE_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then
  return ''
end

local ok, decoded = pcall(cjson.decode, current)
if not ok or not decoded.settings then
  return ''
end

if decoded.settings.scalpModeEnabled ~= true then
  return current
end

decoded.settings.scalpModeEnabled = false
decoded.revision = (tonumber(decoded.revision) or 1) + 1
decoded.updatedAt = ARGV[2]
local encoded = cjson.encode(decoded)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded
`;

export class PerpsAutomationConfigConflictError extends Error {
  current: PerpsAutomationConfig | null;

  constructor(current: PerpsAutomationConfig | null) {
    super("The wallet automation configuration changed on another device.");
    this.name = "PerpsAutomationConfigConflictError";
    this.current = current;
  }
}

async function requireRedis() {
  const redis = await getRedisClient();
  if (!redis) {
    throw new Error("Redis is required for autonomous Perps configuration.");
  }
  return redis;
}
export function parsePerpsAutomationConfig(value: string | null) {
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
  return parsePerpsAutomationConfig(await redis.hGet(REDIS_KEY, walletAddress));
}

export async function listPerpsAutomationConfigs() {
  const redis = await requireRedis();
  const entries = await redis.hVals(REDIS_KEY);
  return entries.flatMap((entry) => {
    const parsed = parsePerpsAutomationConfig(entry);
    return parsed ? [parsed] : [];
  });
}

export async function savePerpsAutomationConfig(
  config: Omit<PerpsAutomationConfig, "revision">,
  expectedRevision: number
) {
  const parsed = perpsAutomationConfigSchema.parse({ ...config, revision: 1 });
  const redis = await requireRedis();
  const result = await redis.eval(SAVE_CONFIG_SCRIPT, {
    keys: [REDIS_KEY],
    arguments: [parsed.walletAddress, String(expectedRevision), JSON.stringify(parsed)],
  });
  const [saved, raw] = Array.isArray(result) ? result : [];
  const savedFlag = Number(saved);
  const serialized = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  if (savedFlag !== 1) {
    throw new PerpsAutomationConfigConflictError(parsePerpsAutomationConfig(serialized));
  }
  const next = parsePerpsAutomationConfig(serialized);
  if (!next) throw new Error("Redis returned an invalid autonomous Perps configuration.");
  return next;
}

export async function deletePerpsAutomationConfig(walletAddress: string) {
  const redis = await requireRedis();
  await redis.hDel(REDIS_KEY, walletAddress);
}

export async function disablePerpsScalpMode(walletAddress: string) {
  const redis = await requireRedis();
  const result = await redis.eval(DISABLE_SCALP_MODE_SCRIPT, {
    keys: [REDIS_KEY],
    arguments: [walletAddress, new Date().toISOString()],
  });
  const serialized = typeof result === "string" ? result : Buffer.isBuffer(result) ? result.toString("utf8") : "";
  return parsePerpsAutomationConfig(serialized);
}
