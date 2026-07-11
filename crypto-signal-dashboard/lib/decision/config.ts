import path from "node:path";

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getTradeDecisionConfig() {
  const decisionLogDir = process.env.PERPS_DECISION_LOG_DIR?.trim()
    || path.join(process.cwd(), "logs", "decision-layer");

  return {
    shadowMode: readBoolean(process.env.PERPS_DECISION_SHADOW_MODE, true),
    allowExecutionOverrides: readBoolean(process.env.PERPS_DECISION_ALLOW_OVERRIDES, false),
    confidenceThreshold: clamp(readNumber(process.env.PERPS_DECISION_CONFIDENCE_THRESHOLD, 0.58), 0, 1),
    journalFilePath: process.env.PERPS_DECISION_JOURNAL_FILE?.trim()
      || path.join(decisionLogDir, "trade-decision-journal.md"),
    eventsFilePath: process.env.PERPS_DECISION_EVENTS_FILE?.trim()
      || path.join(decisionLogDir, "trade-decision-events.ndjson"),
  };
}
