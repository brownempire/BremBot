import fs from "node:fs";

import {
  scalpCandidateSchema,
  type ScalpCandidate,
  type ScalpCandidateForwardLabel,
  type ScalpOutcomeClass,
} from "@/lib/decision/learningTypes";
import type { PricePoint } from "@/lib/price/simulated";
import { getRedisClient } from "@/lib/server/redis";

const CANDIDATE_FILE = process.env.PERPS_SCALP_CANDIDATES_FILE || "/tmp/brembot-perps-scalp-candidates.json";
const CANDIDATE_KEY_PREFIX = "brembot:perps:scalp:candidates:v2";
const MAX_CANDIDATES_PER_WALLET = 2_048;
const CANDIDATE_PRUNE_TARGET = 1_536;
const FORWARD_HORIZONS = [5, 15, 30, 60] as const;

type ScalpCandidateInput = Omit<ScalpCandidate, "createdAt" | "updatedAt" | "labels"> & {
  createdAt?: string;
  updatedAt?: string;
  labels?: ScalpCandidate["labels"];
};

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  } catch {
    // Redis is authoritative in production; disk is a local fail-safe.
  }
}

function parseCandidate(value: unknown) {
  const parsed = scalpCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function candidateKey(walletAddress: string) {
  return `${CANDIDATE_KEY_PREFIX}:${walletAddress}`;
}

async function readRedisCandidate(candidateId: string, walletAddress: string) {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return null;
  try {
    const raw = await redis.hGet(candidateKey(walletAddress), candidateId);
    return raw ? parseCandidate(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function getScalpCandidate(candidateId: string, walletAddress: string) {
  const redisCandidate = await readRedisCandidate(candidateId, walletAddress);
  if (redisCandidate) return redisCandidate;
  const local = parseCandidate(readJsonFile(CANDIDATE_FILE)[candidateId]);
  return local?.walletAddress === walletAddress ? local : null;
}

export async function listScalpCandidates(input: {
  walletAddress: string;
  policyVersion?: number;
  disposition?: "accepted" | "rejected";
  observedAfter?: number;
}) {
  const candidates = new Map<string, ScalpCandidate>();
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      const values = await redis.hVals(candidateKey(input.walletAddress));
      values.forEach((value) => {
        try {
          const candidate = parseCandidate(JSON.parse(value));
          if (candidate) candidates.set(candidate.candidateId, candidate);
        } catch {
          // Ignore malformed records.
        }
      });
    } catch {
      // Merge the local fail-safe below.
    }
  }
  Object.values(readJsonFile(CANDIDATE_FILE)).forEach((value) => {
    const candidate = parseCandidate(value);
    if (candidate) candidates.set(candidate.candidateId, candidate);
  });
  return [...candidates.values()]
    .filter((candidate) => candidate.walletAddress === input.walletAddress)
    .filter((candidate) => input.policyVersion === undefined || candidate.policyVersion === input.policyVersion)
    .filter((candidate) => input.disposition === undefined || candidate.disposition === input.disposition)
    .filter((candidate) => input.observedAfter === undefined || Date.parse(candidate.observedAt) >= input.observedAfter)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

async function pruneRedisCandidates(walletAddress: string) {
  const redis = await getRedisClient().catch(() => null);
  if (!redis) return;
  const key = candidateKey(walletAddress);
  try {
    const count = await redis.hLen(key);
    if (count <= MAX_CANDIDATES_PER_WALLET) return;
    const values = await redis.hGetAll(key);
    const staleIds = Object.entries(values)
      .map(([candidateId, raw]) => {
        try {
          return { candidateId, candidate: parseCandidate(JSON.parse(raw)) };
        } catch {
          return { candidateId, candidate: null };
        }
      })
      .sort((left, right) => (
        Date.parse(left.candidate?.observedAt ?? "1970-01-01T00:00:00.000Z")
        - Date.parse(right.candidate?.observedAt ?? "1970-01-01T00:00:00.000Z")
      ))
      .slice(0, Math.max(0, count - CANDIDATE_PRUNE_TARGET))
      .map((item) => item.candidateId);
    if (staleIds.length > 0) await redis.hDel(key, staleIds);
  } catch {
    // Candidate telemetry is non-authoritative; live safety gates do not use it.
  }
}

function pruneLocalCandidates(records: Record<string, unknown>, walletAddress: string) {
  const walletCandidates = Object.entries(records)
    .map(([candidateId, value]) => ({ candidateId, candidate: parseCandidate(value) }))
    .filter((item) => item.candidate?.walletAddress === walletAddress)
    .sort((left, right) => Date.parse(left.candidate!.observedAt) - Date.parse(right.candidate!.observedAt));
  if (walletCandidates.length <= MAX_CANDIDATES_PER_WALLET) return records;
  walletCandidates
    .slice(0, walletCandidates.length - CANDIDATE_PRUNE_TARGET)
    .forEach((item) => { delete records[item.candidateId]; });
  return records;
}

export async function saveScalpCandidate(input: ScalpCandidateInput) {
  const existing = await getScalpCandidate(input.candidateId, input.walletAddress);
  if (existing && existing.walletAddress !== input.walletAddress) {
    throw new Error(`Scalp candidate ${input.candidateId} cannot move across wallet boundaries.`);
  }
  const now = new Date().toISOString();
  const parsed = scalpCandidateSchema.parse({
    ...existing,
    ...input,
    rejectionReasons: input.rejectionReasons ?? existing?.rejectionReasons ?? [],
    metrics: { ...existing?.metrics, ...input.metrics },
    tags: input.tags ?? existing?.tags ?? [],
    labels: { ...existing?.labels, ...input.labels },
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  });
  const redis = await getRedisClient().catch(() => null);
  if (redis) {
    try {
      await redis.hSet(candidateKey(parsed.walletAddress), parsed.candidateId, JSON.stringify(parsed));
      await pruneRedisCandidates(parsed.walletAddress);
      return parsed;
    } catch {
      // Local fail-safe below.
    }
  }
  const disk = readJsonFile(CANDIDATE_FILE);
  disk[parsed.candidateId] = parsed;
  writeJsonFile(CANDIDATE_FILE, pruneLocalCandidates(disk, parsed.walletAddress));
  return parsed;
}

function pointHigh(point: PricePoint) {
  return point.h ?? Math.max(point.o ?? point.v, point.v);
}

function pointLow(point: PricePoint) {
  return point.l ?? Math.min(point.o ?? point.v, point.v);
}

function percent(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator * 100 : 0;
}

function candidateBarrier(candidate: ScalpCandidate, name: "shadowTakeProfitMovePercent" | "shadowStopLossMovePercent") {
  const configured = candidate.metrics[name];
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return configured;
  const atr = candidate.metrics.atrPercent;
  const baseAtr = typeof atr === "number" && Number.isFinite(atr) && atr > 0 ? atr : 0.18;
  return name === "shadowTakeProfitMovePercent"
    ? Math.min(0.8, Math.max(0.12, baseAtr * 1.25))
    : Math.min(0.6, Math.max(0.1, baseAtr * 0.9));
}

/**
 * Applies deterministic, direction-normalized barrier labels to every setup,
 * including rejected shadow candidates. If TP and SL are both crossed inside
 * one minute candle, the conservative label is full-SL because tick order is
 * unknowable from OHLC data. A profitable-staircase label requires a favorable
 * arm on an earlier candle followed by a retreat through its protected floor.
 */
export function classifyScalpCandidateFirstTouch(input: {
  candidate: ScalpCandidate;
  points: PricePoint[];
}): ScalpOutcomeClass | null {
  const observedAt = Date.parse(input.candidate.observedAt);
  const reference = input.candidate.referencePrice;
  const long = input.candidate.side === "long";
  const takeProfitMove = candidateBarrier(input.candidate, "shadowTakeProfitMovePercent");
  const stopLossMove = candidateBarrier(input.candidate, "shadowStopLossMovePercent");
  const takeProfit = reference * (1 + (long ? 1 : -1) * takeProfitMove / 100);
  const stopLoss = reference * (1 + (long ? -1 : 1) * stopLossMove / 100);
  const armMove = Math.max(0.05, takeProfitMove * 0.5);
  const protectedMove = Math.max(0.02, armMove * 0.7);
  const armPrice = reference * (1 + (long ? 1 : -1) * armMove / 100);
  const protectedPrice = reference * (1 + (long ? 1 : -1) * protectedMove / 100);
  let armed = false;
  const points = input.points
    .filter((point) => point.t > observedAt && point.t <= observedAt + 60 * 60_000)
    .sort((left, right) => left.t - right.t);
  if (points.length === 0) return null;
  for (const point of points) {
    const high = pointHigh(point);
    const low = pointLow(point);
    const tpHit = long ? high >= takeProfit : low <= takeProfit;
    const slHit = long ? low <= stopLoss : high >= stopLoss;
    if (tpHit && slHit) return "full-sl";
    if (slHit) return "full-sl";
    if (tpHit) return "full-tp";
    const armedThisCandle = long ? high >= armPrice : low <= armPrice;
    const protectedExitHit = long ? low <= protectedPrice : high >= protectedPrice;
    if (armed && protectedExitHit) return "profitable-staircase";
    if (armedThisCandle) armed = true;
  }
  return "neutral";
}

export function computeScalpCandidateForwardLabels(input: {
  candidate: ScalpCandidate;
  points: PricePoint[];
  evaluatedAt?: number;
}) {
  const observedAt = Date.parse(input.candidate.observedAt);
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const labels: Partial<Record<`${(typeof FORWARD_HORIZONS)[number]}`, ScalpCandidateForwardLabel>> = {};
  const points = input.points
    .filter((point) => point.t > observedAt && point.t <= observedAt + 60 * 60_000)
    .sort((left, right) => left.t - right.t);

  FORWARD_HORIZONS.forEach((horizonMinutes) => {
    const targetAt = observedAt + horizonMinutes * 60_000;
    if (evaluatedAt < targetAt) return;
    const horizonPoints = points.filter((point) => point.t <= targetAt);
    const endpoint = horizonPoints[horizonPoints.length - 1];
    if (!endpoint || endpoint.t < targetAt - 60_000) return;
    const maximumPrice = Math.max(...horizonPoints.map(pointHigh));
    const minimumPrice = Math.min(...horizonPoints.map(pointLow));
    const referencePrice = input.candidate.referencePrice;
    const long = input.candidate.side === "long";
    labels[`${horizonMinutes}`] = {
      horizonMinutes,
      targetAt: new Date(targetAt).toISOString(),
      evaluatedAt: new Date(evaluatedAt).toISOString(),
      sampleSize: horizonPoints.length,
      endpointPrice: endpoint.v,
      maximumPrice,
      minimumPrice,
      directionalReturnPercent: Number(percent(
        long ? endpoint.v - referencePrice : referencePrice - endpoint.v,
        referencePrice
      ).toFixed(6)),
      maximumFavorableExcursionPercent: Number(Math.max(0, percent(
        long ? maximumPrice - referencePrice : referencePrice - minimumPrice,
        referencePrice
      )).toFixed(6)),
      maximumAdverseExcursionPercent: Number(Math.max(0, percent(
        long ? referencePrice - minimumPrice : maximumPrice - referencePrice,
        referencePrice
      )).toFixed(6)),
    };
  });
  return labels;
}

export async function labelScalpCandidateHorizons(input: {
  candidateId: string;
  walletAddress: string;
  points: PricePoint[];
  evaluatedAt?: number;
}) {
  const candidate = await getScalpCandidate(input.candidateId, input.walletAddress);
  if (!candidate) throw new Error(`Scalp candidate ${input.candidateId} was not found.`);
  const labels = computeScalpCandidateForwardLabels({
    candidate,
    points: input.points,
    evaluatedAt: input.evaluatedAt,
  });
  const outcomeClass = labels["60"]
    ? classifyScalpCandidateFirstTouch({ candidate, points: input.points })
    : candidate.outcomeClass ?? null;
  return saveScalpCandidate({
    ...candidate,
    labels: { ...candidate.labels, ...labels },
    outcomeClass,
    outcomeSource: outcomeClass ? "shadow-first-touch" : candidate.outcomeSource ?? null,
  });
}

export async function labelMatureScalpCandidates(input: {
  walletAddress: string;
  points: PricePoint[];
  policyVersion?: number;
  evaluatedAt?: number;
}) {
  const candidates = await listScalpCandidates({
    walletAddress: input.walletAddress,
    policyVersion: input.policyVersion,
    observedAfter: (input.evaluatedAt ?? Date.now()) - 3 * 60 * 60_000,
  });
  const updated: ScalpCandidate[] = [];
  for (const candidate of candidates) {
    const labels = computeScalpCandidateForwardLabels({
      candidate,
      points: input.points,
      evaluatedAt: input.evaluatedAt,
    });
    const changed = Object.keys(labels).some((horizon) => (
      candidate.labels[horizon as keyof typeof candidate.labels] === undefined
    ));
    const outcomeClass = labels["60"]
      ? classifyScalpCandidateFirstTouch({ candidate, points: input.points })
      : candidate.outcomeClass ?? null;
    updated.push(changed
      ? await saveScalpCandidate({
          ...candidate,
          labels: { ...candidate.labels, ...labels },
          outcomeClass,
          outcomeSource: outcomeClass ? "shadow-first-touch" : candidate.outcomeSource ?? null,
        })
      : candidate);
  }
  return updated;
}
