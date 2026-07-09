import { getPerpsRuntimeOverride, setPerpsKillSwitchOverride } from "@/lib/perps/auditLog";
import { getPerpsRuntimeSettings } from "@/lib/perps/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = getPerpsRuntimeSettings();
  const override = await getPerpsRuntimeOverride();
  const effectiveKillSwitch = override.killSwitchOverride ?? settings.killSwitch;

  return Response.json({
    paperTrading: settings.paperTrading,
    accountLabel: settings.paperTrading ? "Paper account" : "Real account",
    killSwitch: effectiveKillSwitch,
    killSwitchOverride: override.killSwitchOverride,
    allowedMarkets: settings.allowedMarkets,
    maxLeverage: settings.maxLeverage,
    maxTradePct: settings.maxTradePct,
    maxExposurePct: settings.maxExposurePct,
    maxDailyLossPct: settings.maxDailyLossPct,
    cooldownSeconds: settings.cooldownSeconds,
    duplicateWindowSeconds: settings.duplicateWindowSeconds,
    maxSlippageBps: settings.maxSlippageBps,
    assumedCapitalUsd: settings.assumedCapitalUsd,
  });
}

export async function PATCH(request: Request) {
  const payload = await request.json().catch(() => null) as { killSwitch?: boolean | null } | null;
  if (payload?.killSwitch !== true && payload?.killSwitch !== false && payload?.killSwitch !== null) {
    return Response.json({ error: "killSwitch must be true, false, or null." }, { status: 400 });
  }

  const state = await setPerpsKillSwitchOverride(payload.killSwitch);
  return Response.json({ ok: true, state });
}
