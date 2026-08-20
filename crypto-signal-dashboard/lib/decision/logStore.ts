import fs from "node:fs";
import path from "node:path";

import { getTradeDecisionConfig } from "@/lib/decision/config";
import { tradeDecisionRecordSchema, type TradeDecisionRecord } from "@/lib/decision/types";
import { shortenWalletAddress } from "@/lib/jupiterPerps";
import { getRedisClient } from "@/lib/server/redis";
import { formatUsd } from "@/lib/utils";

const DECISION_RECORDS_REDIS_KEY = "brembot:perps:decision-records:v1";

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function formatNumber(value: number | null | undefined, fractionDigits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(fractionDigits);
}

function formatOptionalUsd(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return formatUsd(value);
}

function formatDecisionMarkdown(record: TradeDecisionRecord) {
  const { payload, recommendation } = record;
  const market = payload.marketContext;
  const history = payload.historyContext;

  return [
    `## ${payload.createdAt} · ${(payload.strategyClass ?? "smart").toUpperCase()} · ${payload.symbol} · ${payload.direction.toUpperCase()} · ${payload.sessionMode.toUpperCase()}`,
    `- Wallet: ${shortenWalletAddress(payload.walletAddress)}`,
    `- Session: ${payload.sessionId} · ${payload.executionModel} · shadow mode ${recommendation.shadowMode ? "on" : "off"}`,
    `- Decision: ${recommendation.shouldTrade ? "TAKE" : "SKIP"} · confidence ${formatNumber(recommendation.confidenceScore, 3)} · risk ${recommendation.riskGrade}`,
    `- Requested: ${formatUsd(payload.requestedTrade.collateralUsd)} collateral · ${formatNumber(payload.requestedTrade.leverage)}x leverage · TP ${formatOptionalUsd(payload.requestedTrade.takeProfitPrice)} · SL ${formatOptionalUsd(payload.requestedTrade.stopLossPrice)}`,
    `- Suggested: ${formatUsd(recommendation.recommendedCollateralUsd)} collateral · ${formatNumber(recommendation.recommendedLeverage)}x leverage · TP ${formatOptionalUsd(recommendation.recommendedTakeProfitPrice)} · SL ${formatOptionalUsd(recommendation.recommendedStopLossPrice)}`,
    `- Market: spot ${formatOptionalUsd(market.spotPrice)} · volatility ${formatNumber(market.volatilityPercent, 2)}% · trend ${market.trendBias ?? "-"} · recent move ${formatNumber(market.recentPriceChangePercent, 2)}% · available USDC ${formatOptionalUsd(market.availableUsdc)} · open position ${market.hasOpenPosition ? "yes" : "no"}`,
    `- History: ${history.recentExecutionCount} recent executions · failures ${formatNumber(history.recentFailureRate * 100, 1)}% · blocked ${formatNumber(history.recentBlockedRate * 100, 1)}%`,
    `- Tags: ${recommendation.explanationTags.map((tag) => `\`${tag}\``).join(", ")}`,
    `- Summary: ${recommendation.explanationSummary}`,
    "",
  ].join("\n");
}

export async function appendTradeDecisionRecord(
  record: TradeDecisionRecord,
  options: { requireAuthoritative?: boolean } = {}
) {
  const config = getTradeDecisionConfig();
  const markdownEntry = formatDecisionMarkdown(record);
  const ndjsonEntry = `${JSON.stringify(record)}\n`;

  try {
    const client = await getRedisClient();
    if (client) {
      await client.hSet(
        DECISION_RECORDS_REDIS_KEY,
        record.payload.decisionId,
        JSON.stringify(record)
      );
    } else if (options.requireAuthoritative) {
      throw new Error("Authoritative Redis decision audit is unavailable.");
    }
  } catch (error) {
    if (options.requireAuthoritative) {
      throw new Error(
        `The live scalp decision could not be written to the authoritative audit: ${error instanceof Error ? error.message : "Redis write failed"}`
      );
    }
    // The local fallback below keeps decision logging non-fatal.
  }

  try {
    ensureParentDir(config.journalFilePath);
    ensureParentDir(config.eventsFilePath);
    if (!fs.existsSync(config.journalFilePath)) {
      fs.writeFileSync(
        config.journalFilePath,
        "# BremLogic Trade Decision Journal\n\nReadable decision-layer audit trail. Newest decisions are appended below.\n\n",
        "utf8"
      );
    }
    fs.appendFileSync(config.journalFilePath, markdownEntry, "utf8");
    fs.appendFileSync(config.eventsFilePath, ndjsonEntry, "utf8");
  } catch {
    // Logging should never break trading flow.
  }
}

function readTradeDecisionRecordsFromDisk() {
  const config = getTradeDecisionConfig();

  try {
    if (!fs.existsSync(config.eventsFilePath)) return [] as TradeDecisionRecord[];
    const raw = fs.readFileSync(config.eventsFilePath, "utf8");
    return raw.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try {
        const result = tradeDecisionRecordSchema.safeParse(JSON.parse(line));
        return result.success ? [result.data] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [] as TradeDecisionRecord[];
  }
}

async function readTradeDecisionRecordsFromRedis() {
  try {
    const client = await getRedisClient();
    if (!client) return null;
    const values = await client.hVals(DECISION_RECORDS_REDIS_KEY);
    return values.flatMap((value) => {
      try {
        const result = tradeDecisionRecordSchema.safeParse(JSON.parse(value));
        return result.success ? [result.data] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  }
}

async function readTradeDecisionRecordsFromRedisAuthoritative() {
  const client = await getRedisClient().catch(() => null);
  if (!client) throw new Error("Authoritative Redis decision audit is unavailable; live scalp admission is blocked.");
  let values: string[];
  try {
    values = await client.hVals(DECISION_RECORDS_REDIS_KEY);
  } catch (error) {
    throw new Error(
      `Authoritative Redis decision audit could not be read: ${error instanceof Error ? error.message : "unknown Redis error"}`
    );
  }
  return values.map((value) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error("An authoritative Redis decision record contains malformed JSON.");
    }
    return tradeDecisionRecordSchema.parse(decoded);
  });
}

export async function listTradeDecisionRecords(limit = 50, walletAddress?: string | null) {
  const redisRecords = await readTradeDecisionRecordsFromRedis();
  const diskRecords = readTradeDecisionRecordsFromDisk();
  const recordsById = new Map<string, TradeDecisionRecord>();
  diskRecords.forEach((record) => recordsById.set(record.payload.decisionId, record));
  redisRecords?.forEach((record) => recordsById.set(record.payload.decisionId, record));

  return [...recordsById.values()]
    .filter((record) => !walletAddress || record.payload.walletAddress === walletAddress)
    .sort((left, right) => Date.parse(right.payload.createdAt) - Date.parse(left.payload.createdAt))
    .slice(0, Math.max(1, limit));
}

export async function listTradeDecisionRecordsAuthoritative(limit = 50, walletAddress?: string | null) {
  const records = await readTradeDecisionRecordsFromRedisAuthoritative();
  return records
    .filter((record) => !walletAddress || record.payload.walletAddress === walletAddress)
    .sort((left, right) => Date.parse(right.payload.createdAt) - Date.parse(left.payload.createdAt))
    .slice(0, Math.max(1, limit));
}

/**
 * Returns the complete authoritative decision journal for one wallet. Outcome
 * reconciliation must not use a global row limit: an older execution can be
 * reconciled late, and omitting its matching decision would erase its scalp
 * attribution from the live circuit breaker.
 */
export async function listAllTradeDecisionRecordsAuthoritative(walletAddress: string) {
  const records = await readTradeDecisionRecordsFromRedisAuthoritative();
  return records
    .filter((record) => record.payload.walletAddress === walletAddress)
    .sort((left, right) => Date.parse(right.payload.createdAt) - Date.parse(left.payload.createdAt));
}

export async function readTradeDecisionJournal(walletAddress?: string | null) {
  const records = await listTradeDecisionRecords(100, walletAddress);
  if (records.length > 0) {
    return [
      "# BremLogic Trade Decision Journal",
      "",
      ...records.map(formatDecisionMarkdown),
    ].join("\n");
  }

  return "# BremLogic Trade Decision Journal\n\nNo decision entries have been written yet.\n";
}
