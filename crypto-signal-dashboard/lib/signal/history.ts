import type { Signal } from "@/lib/signal/engine";

export const MAX_SIGNAL_HISTORY = 20;
export const VISIBLE_SIGNAL_ROWS = 5;

export function sanitizeSignalHistoryItem(input: unknown): Signal | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<Signal>;
  const id = String(candidate.id ?? "").trim().slice(0, 180);
  const symbol = String(candidate.symbol ?? "").trim().slice(0, 40);
  const summary = String(candidate.summary ?? "").trim().slice(0, 500);
  const timestamp = Number(candidate.timestamp ?? 0);
  const confidence = Number(candidate.confidence ?? NaN);
  if (
    !id
    || !symbol
    || !summary
    || !Number.isFinite(timestamp)
    || timestamp <= 0
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
    || (candidate.type !== "trend" && candidate.type !== "breakout")
    || (candidate.direction !== "bullish" && candidate.direction !== "bearish")
  ) {
    return null;
  }

  return {
    id,
    symbol,
    summary,
    timestamp,
    confidence,
    type: candidate.type,
    direction: candidate.direction,
  };
}

export function normalizeSignalHistory(inputs: unknown[]) {
  const byId = new Map<string, Signal>();
  inputs.forEach((input) => {
    const signal = sanitizeSignalHistoryItem(input);
    if (!signal) return;
    const existing = byId.get(signal.id);
    if (!existing || signal.timestamp > existing.timestamp) byId.set(signal.id, signal);
  });
  return [...byId.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_SIGNAL_HISTORY);
}
