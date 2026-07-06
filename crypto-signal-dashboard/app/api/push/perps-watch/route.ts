import { fetchJupiterPerpsAccountSnapshot, type JupiterPerpsPendingTrigger, type JupiterPerpsPosition, type JupiterPerpsTrade } from "@/lib/jupiterPerps";
import { listSubscribedWalletAddresses } from "@/lib/push/store";
import { getPerpsWatchState, savePerpsWatchState } from "@/lib/perpsWatchStore";
import { getAnyPushConfigError, sendNotificationPayload } from "@/lib/push/dispatch";
import { listNativePushDevices } from "@/lib/push/nativeStore";

export const dynamic = "force-dynamic";

function validateCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return true;
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return token === secret;
}

function getPositionKey(position: JupiterPerpsPosition) {
  return position.accountRef?.trim()
    || `${position.custodyAddress ?? "unknown"}:${position.collateralCustodyAddress ?? "unknown"}:${position.side}`;
}

function getTriggerPositionKey(trigger: JupiterPerpsPendingTrigger) {
  return trigger.positionPubkey?.trim()
    || `${trigger.custodyAddress ?? "unknown"}:${trigger.collateralCustodyAddress ?? "unknown"}:${trigger.side}`;
}

function findCloseReason(
  position: JupiterPerpsPosition,
  previousTriggers: JupiterPerpsPendingTrigger[],
  recentTrades: JupiterPerpsTrade[]
) {
  const triggerForPosition = previousTriggers.filter((trigger) => getTriggerPositionKey(trigger) === getPositionKey(position));
  const latestTrade = [...recentTrades]
    .filter((trade) => trade.positionPubkey?.trim() === position.accountRef?.trim())
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0];
  const action = latestTrade?.action?.toLowerCase() ?? "";

  if (action.includes("liquid")) return "margin call";
  if (triggerForPosition.some((trigger) => trigger.kind === "take-profit")) return "TP";
  if (triggerForPosition.some((trigger) => trigger.kind === "stop-loss")) return "SL";
  return "manual close";
}

export async function GET(request: Request) {
  if (!validateCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const configError = getAnyPushConfigError();
  if (configError) {
    return Response.json({ error: configError }, { status: 400 });
  }

  const nativeWallets = await listNativePushDevices();
  const walletAddresses = [...new Set([
    ...(await listSubscribedWalletAddresses()),
    ...nativeWallets
      .map((device) => device.walletAddress?.trim())
      .filter((walletAddress): walletAddress is string => Boolean(walletAddress)),
  ])];
  const notifications: Array<{ walletAddress: string; title: string; body: string; url: string; sound?: string }> = [];

  for (const walletAddress of walletAddresses) {
    const previousState = await getPerpsWatchState(walletAddress);
    const snapshot = await fetchJupiterPerpsAccountSnapshot(walletAddress).catch(() => null);
    if (!snapshot) continue;

    const previousPositions = previousState?.snapshot.positions ?? [];
    const previousTriggers = previousState?.snapshot.pendingTriggers ?? [];
    const previousPositionMap = new Map(previousPositions.map((position) => [getPositionKey(position), position]));
    const currentPositionMap = new Map(snapshot.positions.map((position) => [getPositionKey(position), position]));

    snapshot.positions.forEach((position) => {
      if (previousPositionMap.has(getPositionKey(position))) return;
      notifications.push({
        walletAddress,
        title: `Trade Filled: ${position.marketSymbol}`,
        body: `${position.side === "long" ? "Long" : "Short"} opened${position.entryPrice ? ` at $${position.entryPrice}` : ""}.`,
        url: "/signals-bot?tab=perps",
        sound: "brem_approval.wav",
      });
    });

    previousPositions.forEach((position) => {
      if (currentPositionMap.has(getPositionKey(position))) return;
      const closeReason = findCloseReason(position, previousTriggers, snapshot.recentTrades);
      notifications.push({
        walletAddress,
        title: `Trade Closed: ${position.marketSymbol}`,
        body: `${position.side === "long" ? "Long" : "Short"} closed by ${closeReason}.`,
        url: "/signals-bot?tab=perps",
        sound: closeReason === "TP" ? "brem_tp.wav" : closeReason === "SL" ? "brem_sl.wav" : undefined,
      });
    });

    await savePerpsWatchState({
      walletAddress,
      lastCheckedAt: Date.now(),
      snapshot,
    });
  }

  const results = await Promise.all(
    notifications.map((notification) => sendNotificationPayload(notification))
  );

  return Response.json({
    ok: true,
    wallets: walletAddresses.length,
    notifications: notifications.length,
    sent: results.reduce((sum, result) => sum + result.sent, 0),
  });
}
