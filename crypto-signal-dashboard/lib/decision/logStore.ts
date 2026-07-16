import fs from "node:fs";
import path from "node:path";

import { getTradeDecisionConfig } from "@/lib/decision/config";
import { tradeDecisionRecordSchema, type TradeDecisionRecord } from "@/lib/decision/types";
import { shortenWalletAddress } from "@/lib/jupiterPerps";
import { formatUsd } from "@/lib/utils";

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
    `## ${payload.createdAt} · ${payload.symbol} · ${payload.direction.toUpperCase()} · ${payload.sessionMode.toUpperCase()}`,
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

export async function appendTradeDecisionRecord(record: TradeDecisionRecord) {
  const config = getTradeDecisionConfig();
  const markdownEntry = formatDecisionMarkdown(record);
  const ndjsonEntry = `${JSON.stringify(record)}\n`;

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

export async function readTradeDecisionJournal() {
  const config = getTradeDecisionConfig();

  try {
    if (!fs.existsSync(config.journalFilePath)) {
      return "# BremLogic Trade Decision Journal\n\nNo decision entries have been written yet.\n";
    }
    return fs.readFileSync(config.journalFilePath, "utf8");
  } catch {
    return "# BremLogic Trade Decision Journal\n\nUnable to read the decision journal right now.\n";
  }
}

export async function listTradeDecisionRecords(limit = 50) {
  const config = getTradeDecisionConfig();

  try {
    if (!fs.existsSync(config.eventsFilePath)) {
      return [] as TradeDecisionRecord[];
    }

    const raw = fs.readFileSync(config.eventsFilePath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const parsed = lines.flatMap((line) => {
      try {
        const record = JSON.parse(line);
        const result = tradeDecisionRecordSchema.safeParse(record);
        return result.success ? [result.data] : [];
      } catch {
        return [];
      }
    });

    return parsed
      .sort((left, right) => Date.parse(right.payload.createdAt) - Date.parse(left.payload.createdAt))
      .slice(0, Math.max(1, limit));
  } catch {
    return [] as TradeDecisionRecord[];
  }
}
