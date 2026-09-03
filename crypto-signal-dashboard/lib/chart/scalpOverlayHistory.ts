import { getRedisClient } from "@/lib/server/redis";
import { scalpCandidateSchema, tradeLearningOutcomeSchema, type ScalpCandidate, type TradeLearningOutcome } from "@/lib/decision/learningTypes";

const HISTORY_TTL_MS = 30_000;
type OverlayHistory = { candidates: ScalpCandidate[]; latestClosed: TradeLearningOutcome | null };
const local = new Map<string, { expiresAt: number; value: OverlayHistory }>();
const inflight = new Map<string, Promise<OverlayHistory>>();

// Project inside Redis: do NOT transfer the multi-megabyte candidate/outcome
// histories to each app request. Authoritative hashes are read, never modified.
// Only the overlay's 20 most recent market markers and latest scalp close leave
// Redis. A short-lived shared cache also covers cold workers/other devices.
export const SCALP_OVERLAY_HISTORY_SCRIPT = `
local cached = redis.call('GET', KEYS[3])
if cached then return {redis.call('PTTL', KEYS[3]), cached} end
local candidates = {}
local selected = {}
local wallet, asset, cutoff = ARGV[1], ARGV[2], ARGV[3]
local cursor = '0'
repeat
 local page = redis.call('HSCAN', KEYS[1], cursor, 'COUNT', 16)
 cursor = page[1]
 for index = 2, #page[2], 2 do
  local raw = page[2][index]
  local ok, item = pcall(cjson.decode, raw)
  if ok and type(item) == 'table' and item.walletAddress == wallet
    and item.asset == asset and item.setupType and item.setupType ~= cjson.null
    and type(item.observedAt) == 'string' and type(item.candidateId) == 'string' and item.observedAt >= cutoff
    and not selected[item.candidateId] then
    selected[item.candidateId] = true
    table.insert(candidates, {observedAt=item.observedAt,candidateId=item.candidateId,raw=raw})
    table.sort(candidates, function(a,b)
      if a.observedAt == b.observedAt then return a.candidateId < b.candidateId end
      return a.observedAt > b.observedAt
    end)
    if #candidates > 20 then selected[table.remove(candidates).candidateId] = nil end
  end
 end
until cursor == '0'
local latest = cjson.null
local latestTime = ''
repeat
 local page = redis.call('HSCAN', KEYS[2], cursor, 'COUNT', 16)
 cursor = page[1]
 for index = 2, #page[2], 2 do
  local raw = page[2][index]
  local ok, item = pcall(cjson.decode, raw)
  if ok and type(item) == 'table' and item.walletAddress == wallet
    and type(item.closedAt) == 'string'
    and (item.signalType == 'scalp' or (item.scalpSetupType and item.scalpSetupType ~= cjson.null))
    and item.closedAt > latestTime then latest, latestTime = raw, item.closedAt end
 end
until cursor == '0'
local rows = {}
for _, item in ipairs(candidates) do table.insert(rows,item.raw) end
local result = cjson.encode({candidates=rows, latestClosed=latest})
redis.call('SET', KEYS[3], result, 'PX', ARGV[4])
return {tonumber(ARGV[4]), result}
`;

export async function loadScalpOverlayHistory(walletAddress: string, asset: "SOL" | "ETH" | "BTC"): Promise<OverlayHistory> {
  const key = `${walletAddress}:${asset}`;
  const prior = local.get(key);
  if (prior && prior.expiresAt > Date.now()) return prior.value;
  if (inflight.has(key)) return inflight.get(key)!;
  const task = (async () => {
    const redis = await getRedisClient();
    // Do not hide a database failure behind stale history or a full-history
    // fallback; the route reports unavailable data without affecting trading.
    if (!redis) throw new Error("Scalp overlay history is temporarily unavailable.");
    const response = await redis.eval(SCALP_OVERLAY_HISTORY_SCRIPT, {
      keys: [`brembot:perps:scalp:candidates:v2:${walletAddress}`, "brembot:perps:learning:outcomes:v1", `brembot:perps:overlay-history:v1:${key}`],
      arguments: [walletAddress, asset, new Date(Date.now()-24*60*60_000).toISOString(), String(HISTORY_TTL_MS)],
    }) as [number, string];
    const [remainingTtl, raw] = response;
    const parsed = JSON.parse(String(raw)) as { candidates?: unknown; latestClosed?: unknown };
    const value: OverlayHistory = {
      candidates: (Array.isArray(parsed.candidates) ? parsed.candidates : []).flatMap(row => {
        const result = scalpCandidateSchema.safeParse(typeof row === "string" ? JSON.parse(row) : row);
        return result.success ? [result.data] : [];
      }),
      latestClosed: parsed.latestClosed == null ? null : tradeLearningOutcomeSchema.parse(
        typeof parsed.latestClosed === "string" ? JSON.parse(parsed.latestClosed) : parsed.latestClosed),
    };
    // Keep this memo shorter than Redis's TTL to avoid extending a nearly
    // expired shared result for a second full cache period.
    if (local.size >= 64) local.delete(local.keys().next().value!);
    local.set(key,{value,expiresAt:Date.now()+Math.max(0,Math.min(5_000,Number(remainingTtl)))});
    return value;
  })();
  inflight.set(key,task);
  try { return await task; } finally { inflight.delete(key); }
}
