import { perpsRuntimeSettingsSchema, type PerpsRuntimeSettings } from "@/lib/perps/types";

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readAllowedMarkets(value: string | undefined) {
  const markets = (value ?? "SOL-PERP,ETH-PERP,BTC-PERP")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

  return markets.length > 0 ? markets : ["SOL-PERP", "ETH-PERP", "BTC-PERP"];
}

export function getPerpsRuntimeSettings(): PerpsRuntimeSettings {
  return perpsRuntimeSettingsSchema.parse({
    killSwitch: readBoolean(process.env.PERPS_KILL_SWITCH, false),
    paperTrading: readBoolean(process.env.PERPS_PAPER_TRADING, true),
    allowedMarkets: readAllowedMarkets(process.env.PERPS_ALLOWED_MARKETS),
    maxLeverage: readNumber(process.env.PERPS_MAX_LEVERAGE, 5),
    maxTradePct: readNumber(process.env.PERPS_MAX_TRADE_PCT, 0.1),
    maxExposurePct: readNumber(process.env.PERPS_MAX_EXPOSURE_PCT, 0.5),
    maxDailyLossPct: readNumber(process.env.PERPS_MAX_DAILY_LOSS_PCT, 0.03),
    cooldownSeconds: readInteger(process.env.PERPS_COOLDOWN_SECONDS, 60),
    duplicateWindowSeconds: readInteger(process.env.PERPS_DUPLICATE_WINDOW_SECONDS, 900),
    maxSlippageBps: readInteger(process.env.PERPS_MAX_SLIPPAGE_BPS, 200),
    assumedCapitalUsd: readNumber(process.env.PERPS_ASSUMED_CAPITAL_USD, 1000),
  });
}

export function getPerpsWebhookSecret() {
  const value = process.env.PERPS_WEBHOOK_SECRET?.trim();
  return value || null;
}
