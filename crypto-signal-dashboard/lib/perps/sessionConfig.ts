function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readWalletList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getPerpsSessionConfig() {
  return {
    defaultMode: readBoolean(process.env.PERPS_PAPER_TRADING, true) ? "paper" as const : "live" as const,
    globalKillSwitch: readBoolean(process.env.PERPS_KILL_SWITCH, false),
    allowUnlimitedSession: true,
    defaultUnlimitedSession: false,
    heartbeatTimeoutMs: readNumber(process.env.PERPS_SESSION_HEARTBEAT_TIMEOUT_MS, 60_000),
    maxUserLeverage: readNumber(process.env.PERPS_MAX_LEVERAGE, 5),
    maxTradePct: readNumber(process.env.PERPS_MAX_TRADE_PCT, 0.1),
    maxExposurePct: readNumber(process.env.PERPS_MAX_EXPOSURE_PCT, 0.5),
    maxDailyLossPct: readNumber(process.env.PERPS_MAX_DAILY_LOSS_PCT, 0.03),
    delegatedExecutionAvailable: false,
    liveAllowedWallets: readWalletList(process.env.PERPS_LIVE_ALLOWED_WALLETS),
  };
}

export function isPerpsLiveWalletAllowed(walletAddress: string | null | undefined) {
  if (!walletAddress) return false;
  const allowed = getPerpsSessionConfig().liveAllowedWallets;
  if (allowed.length === 0) return false;
  return allowed.includes(walletAddress.trim());
}
