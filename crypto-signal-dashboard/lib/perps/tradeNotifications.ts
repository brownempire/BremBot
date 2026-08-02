import {
  fetchJupiterPerpsAccountSnapshot,
  type JupiterPerpsAccountSnapshot,
  type JupiterPerpsPendingTrigger,
  type JupiterPerpsPosition,
  type JupiterPerpsTrade,
} from "@/lib/jupiterPerps";
import { getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import { ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE } from "@/lib/perps/scalpExit";
import type { PerpsUserExecution } from "@/lib/perps/sessionTypes";
import { listUserPerpsExecutions } from "@/lib/perps/userExecutionAudit";
import { getPerpsWatchState, savePerpsWatchState } from "@/lib/perpsWatchStore";
import { getAnyPushConfigError, sendNotificationPayload } from "@/lib/push/dispatch";
import { listNativePushDevices } from "@/lib/push/nativeStore";
import { listSubscribedWalletAddresses } from "@/lib/push/store";

const PERPS_URL = "/signals-bot?tab=perps";
const EXIT_PRICE_TOLERANCE = 0.003;

export type TradeNotification = {
  walletAddress: string;
  title: string;
  body: string;
  url: string;
  sound?: string;
};

type ExitReason = "take-profit" | "stop-loss" | "liquidation" | "manual" | "unknown";

type WatchDependencies = {
  listSubscribedWallets: typeof listSubscribedWalletAddresses;
  listNativeDevices: typeof listNativePushDevices;
  getWatchState: typeof getPerpsWatchState;
  saveWatchState: typeof savePerpsWatchState;
  getAgentWallet: typeof getAgentWalletForOwner;
  fetchSnapshot: typeof fetchJupiterPerpsAccountSnapshot;
  listExecutions: typeof listUserPerpsExecutions;
  sendNotification: typeof sendNotificationPayload;
};

const defaultDependencies: WatchDependencies = {
  listSubscribedWallets: listSubscribedWalletAddresses,
  listNativeDevices: listNativePushDevices,
  getWatchState: getPerpsWatchState,
  saveWatchState: savePerpsWatchState,
  getAgentWallet: getAgentWalletForOwner,
  fetchSnapshot: fetchJupiterPerpsAccountSnapshot,
  listExecutions: listUserPerpsExecutions,
  sendNotification: sendNotificationPayload,
};

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatUsd(value: number | null | undefined, signed = false) {
  const next = finite(value);
  if (next === null) return "--";
  const sign = signed ? (next >= 0 ? "+" : "-") : "";
  return `${sign}$${Math.abs(next).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPrice(value: number | null | undefined) {
  const next = finite(value);
  if (next === null || next <= 0) return "--";
  const decimals = next >= 1_000 ? 0 : next >= 1 ? 2 : 5;
  return `$${next.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatLeverage(value: number | null | undefined) {
  const next = finite(value);
  if (next === null) return "--";
  return `${next.toFixed(next >= 10 ? 1 : 2).replace(/\.0$/, "")}x`;
}

function marketAsset(value: string | null | undefined) {
  return (value ?? "PERP").replace(/[-_/]?(USD|PERP)$/i, "").replace(/[^A-Z0-9]/gi, "").toUpperCase() || "PERP";
}

function positionKey(position: JupiterPerpsPosition) {
  return position.accountRef?.trim()
    || `${position.custodyAddress ?? "unknown"}:${position.collateralCustodyAddress ?? "unknown"}:${position.side}`;
}

function triggerPositionKey(trigger: JupiterPerpsPendingTrigger) {
  return trigger.positionPubkey?.trim()
    || `${trigger.custodyAddress ?? "unknown"}:${trigger.collateralCustodyAddress ?? "unknown"}:${trigger.side}`;
}

function isExitTrade(trade: JupiterPerpsTrade) {
  return /close|decrease|liquidat|take.?profit|stop.?loss|\btp\b|\bsl\b/i.test(`${trade.action} ${trade.orderType}`);
}

function tradeTime(trade: JupiterPerpsTrade) {
  return trade.createdAt ?? trade.lastUpdated ?? 0;
}

function matchesPrice(price: number | null | undefined, target: number | null | undefined) {
  const nextPrice = finite(price);
  const nextTarget = finite(target);
  return nextPrice !== null
    && nextTarget !== null
    && nextTarget > 0
    && Math.abs(nextPrice - nextTarget) <= nextTarget * EXIT_PRICE_TOLERANCE;
}

function expectedNetPnl(position: JupiterPerpsPosition, targetPrice: number | null | undefined) {
  const entry = finite(position.entryPrice);
  const mark = finite(position.markPrice);
  const target = finite(targetPrice);
  const size = finite(position.positionSize)
    ?? (
      finite(position.positionValue) !== null && entry !== null && entry > 0
        ? finite(position.positionValue)! / entry
        : null
    );
  if (entry === null || target === null || size === null || size <= 0) return null;
  const priceDelta = position.side === "long" ? target - entry : entry - target;
  const grossTargetPnl = priceDelta * size;
  const liveNetPnl = finite(position.unrealizedPnl);

  // Jupiter's live unrealized PnL is already fee-adjusted. Projecting from that
  // value preserves the fees and borrow accrued on the actual position instead
  // of showing the user a misleading gross-price result.
  if (mark !== null && liveNetPnl !== null) {
    const markToTargetDelta = position.side === "long" ? target - mark : mark - target;
    return Number((liveNetPnl + markToTargetDelta * size).toFixed(2));
  }

  const positionSizeUsd = finite(position.positionValue) ?? Math.abs(entry * size);
  const estimatedFeesUsd = positionSizeUsd * ESTIMATED_PERPS_ROUND_TRIP_FEE_RATE;
  return Number((grossTargetPnl - estimatedFeesUsd).toFixed(2));
}

function strategyLabel(execution: PerpsUserExecution | null) {
  if (execution?.strategyClass === "scalp") return "Scalp";
  if (execution?.strategyClass === "smart") return "Smart";
  return "Perps";
}

function sideLabel(side: JupiterPerpsPosition["side"]) {
  return side === "long" ? "Long" : "Short";
}

function findExecution(position: JupiterPerpsPosition, executions: PerpsUserExecution[]) {
  const direct = position.accountRef
    ? executions.find((execution) => execution.positionPubkey === position.accountRef)
    : null;
  if (direct) return direct;

  const asset = marketAsset(position.marketSymbol);
  return executions
    .filter((execution) => (
      execution.asset === asset
      && execution.side === position.side
      && ["prepared", "submitted", "confirmed", "closed"].includes(execution.status)
    ))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    ?? null;
}

function targetSummary(
  label: "TP" | "SL",
  position: JupiterPerpsPosition,
  price: number | null | undefined
) {
  const nextPrice = finite(price);
  if (nextPrice === null) return `${label} not set`;
  const pnl = expectedNetPnl(position, nextPrice);
  return `${label} ${formatPrice(nextPrice)}${pnl === null ? "" : ` (Est. net ${formatUsd(pnl, true)})`}`;
}

function latestExitTrade(position: JupiterPerpsPosition, trades: JupiterPerpsTrade[]) {
  return trades
    .filter((trade) => (
      trade.positionPubkey?.trim() === position.accountRef?.trim()
      && isExitTrade(trade)
    ))
    .sort((left, right) => tradeTime(right) - tradeTime(left))[0]
    ?? null;
}

export function inferTradeExitReason(options: {
  position: JupiterPerpsPosition;
  previousTriggers: JupiterPerpsPendingTrigger[];
  recentTrades: JupiterPerpsTrade[];
  execution?: PerpsUserExecution | null;
}) {
  const { position, previousTriggers, recentTrades } = options;
  const trade = latestExitTrade(position, recentTrades);
  const label = `${trade?.action ?? ""} ${trade?.orderType ?? ""}`.toLowerCase();
  if (/liquidat/.test(label)) return "liquidation" as const;
  if (/take.?profit|\btp\b/.test(label)) return "take-profit" as const;
  if (/stop.?loss|\bsl\b/.test(label)) return "stop-loss" as const;

  const takeProfit = finite(position.takeProfit) ?? finite(options.execution?.takeProfitPrice);
  const stopLoss = finite(position.stopLoss) ?? finite(options.execution?.stopLossPrice);
  if (matchesPrice(trade?.price, takeProfit)) return "take-profit" as const;
  if (matchesPrice(trade?.price, stopLoss)) return "stop-loss" as const;
  if (matchesPrice(trade?.price, position.liquidationPrice)) return "liquidation" as const;

  const triggerKinds = new Set(
    previousTriggers
      .filter((trigger) => triggerPositionKey(trigger) === positionKey(position))
      .map((trigger) => trigger.kind)
  );
  if (triggerKinds.size === 1 && triggerKinds.has("take-profit")) return "take-profit" as const;
  if (triggerKinds.size === 1 && triggerKinds.has("stop-loss")) return "stop-loss" as const;
  if (/close|decrease/.test(label)) return "manual" as const;
  return "unknown" as const;
}

export function buildTradeEntryNotification(options: {
  walletAddress: string;
  position: JupiterPerpsPosition;
  execution?: PerpsUserExecution | null;
}): TradeNotification {
  const { walletAddress, position } = options;
  const execution = options.execution ?? null;
  const strategy = strategyLabel(execution);
  const asset = marketAsset(position.marketSymbol);
  const tp = finite(position.takeProfit) ?? finite(execution?.takeProfitPrice);
  const sl = finite(position.stopLoss) ?? finite(execution?.stopLossPrice);
  const body = [
    `Entry ${formatPrice(position.entryPrice)} · Mark ${formatPrice(position.markPrice)}`,
    `${formatUsd(position.positionValue ?? execution?.sizeUsd)} position / ${formatUsd(position.collateralValue ?? execution?.collateralUsd)} collateral · ${formatLeverage(position.leverage ?? execution?.leverage)}`,
    `${targetSummary("TP", position, tp)} · ${targetSummary("SL", position, sl)}`,
    `Liq ${formatPrice(position.liquidationPrice)}`,
  ].join(". ");

  return {
    walletAddress,
    title: `${strategy} ${sideLabel(position.side)} Opened · ${asset}`,
    body,
    url: PERPS_URL,
    sound: "brem_approval.wav",
  };
}

function exitTitle(reason: ExitReason, strategy: string, asset: string, side: string) {
  if (reason === "take-profit") return `TP Hit · ${strategy} ${asset} ${side}`;
  if (reason === "stop-loss") return `SL Hit · ${strategy} ${asset} ${side}`;
  if (reason === "liquidation") return `Liquidated · ${strategy} ${asset} ${side}`;
  return `Trade Closed · ${strategy} ${asset} ${side}`;
}

export function buildTradeExitNotification(options: {
  walletAddress: string;
  position: JupiterPerpsPosition;
  previousTriggers: JupiterPerpsPendingTrigger[];
  recentTrades: JupiterPerpsTrade[];
  execution?: PerpsUserExecution | null;
}): TradeNotification {
  const execution = options.execution ?? null;
  const reason = inferTradeExitReason(options);
  const trade = latestExitTrade(options.position, options.recentTrades);
  const strategy = strategyLabel(execution);
  const asset = marketAsset(options.position.marketSymbol);
  const tp = finite(options.position.takeProfit) ?? finite(execution?.takeProfitPrice);
  const sl = finite(options.position.stopLoss) ?? finite(execution?.stopLossPrice);
  const netPnl = finite(trade?.pnl);
  const exitTimestamp = trade ? tradeTime(trade) : 0;
  const durationMinutes = execution && exitTimestamp > 0
    ? Math.max(0, (exitTimestamp - Date.parse(execution.createdAt)) / 60_000)
    : null;
  const body = [
    `Exit ${formatPrice(trade?.price)}${netPnl === null ? "" : ` · Realized ${formatUsd(netPnl, true)}`}`,
    `Entry ${formatPrice(options.position.entryPrice)} · ${formatLeverage(options.position.leverage ?? execution?.leverage)}`,
    `${targetSummary("TP", options.position, tp)} · ${targetSummary("SL", options.position, sl)}`,
    durationMinutes === null ? null : `Held ${durationMinutes < 60 ? `${Math.round(durationMinutes)}m` : `${(durationMinutes / 60).toFixed(1)}h`}`,
  ].filter((value): value is string => Boolean(value)).join(". ");

  return {
    walletAddress: options.walletAddress,
    title: exitTitle(reason, strategy, asset, sideLabel(options.position.side)),
    body,
    url: PERPS_URL,
    sound: reason === "take-profit"
      ? "brem_tp.wav"
      : reason === "stop-loss" || reason === "liquidation"
        ? "brem_sl.wav"
        : undefined,
  };
}

export function buildTradeLifecycleNotifications(options: {
  walletAddress: string;
  previousSnapshot: JupiterPerpsAccountSnapshot;
  currentSnapshot: JupiterPerpsAccountSnapshot;
  executions: PerpsUserExecution[];
}) {
  const previousMap = new Map(options.previousSnapshot.positions.map((position) => [positionKey(position), position]));
  const currentMap = new Map(options.currentSnapshot.positions.map((position) => [positionKey(position), position]));
  const notifications: TradeNotification[] = [];

  options.currentSnapshot.positions.forEach((position) => {
    if (previousMap.has(positionKey(position))) return;
    notifications.push(buildTradeEntryNotification({
      walletAddress: options.walletAddress,
      position,
      execution: findExecution(position, options.executions),
    }));
  });

  options.previousSnapshot.positions.forEach((position) => {
    if (currentMap.has(positionKey(position))) return;
    notifications.push(buildTradeExitNotification({
      walletAddress: options.walletAddress,
      position,
      previousTriggers: options.previousSnapshot.pendingTriggers,
      recentTrades: options.currentSnapshot.recentTrades,
      execution: findExecution(position, options.executions),
    }));
  });

  return notifications;
}

export async function runPerpsTradeNotificationWatch(
  dependencies: WatchDependencies = defaultDependencies
) {
  const configError = getAnyPushConfigError();
  if (configError) {
    return { ok: false, error: configError, wallets: 0, notifications: 0, sent: 0 };
  }

  const nativeWallets = await dependencies.listNativeDevices();
  const walletAddresses = [...new Set([
    ...(await dependencies.listSubscribedWallets()),
    ...nativeWallets
      .map((device) => device.walletAddress?.trim())
      .filter((walletAddress): walletAddress is string => Boolean(walletAddress)),
  ])];
  const notifications: TradeNotification[] = [];

  for (const walletAddress of walletAddresses) {
    const monitoredWalletAddress = dependencies.getAgentWallet(walletAddress) ?? walletAddress;
    const [previousState, snapshot, executions] = await Promise.all([
      dependencies.getWatchState(walletAddress),
      dependencies.fetchSnapshot(monitoredWalletAddress).catch(() => null),
      dependencies.listExecutions(walletAddress).catch(() => []),
    ]);
    if (!snapshot) continue;

    // A missing/legacy state is a bootstrap, not a newly opened trade. This
    // prevents a deployment or wallet-role migration from alerting old positions.
    if (
      previousState
      && previousState.monitoredWalletAddress === monitoredWalletAddress
    ) {
      notifications.push(...buildTradeLifecycleNotifications({
        walletAddress,
        previousSnapshot: previousState.snapshot,
        currentSnapshot: snapshot,
        executions,
      }));
    }

    await dependencies.saveWatchState({
      walletAddress,
      monitoredWalletAddress,
      lastCheckedAt: Date.now(),
      snapshot,
    });
  }

  const results = await Promise.all(
    notifications.map((notification) => dependencies.sendNotification(notification))
  );
  return {
    ok: true,
    wallets: walletAddresses.length,
    notifications: notifications.length,
    sent: results.reduce((sum, result) => sum + result.sent, 0),
  };
}
