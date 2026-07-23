import assert from "node:assert/strict";
import test from "node:test";

import type {
  JupiterPerpsAccountSnapshot,
  JupiterPerpsPendingTrigger,
  JupiterPerpsPosition,
  JupiterPerpsTrade,
} from "../lib/jupiterPerps";
import type { PerpsUserExecution } from "../lib/perps/sessionTypes";
import {
  buildTradeEntryNotification,
  buildTradeExitNotification,
  buildTradeLifecycleNotifications,
  inferTradeExitReason,
} from "../lib/perps/tradeNotifications";

const walletAddress = "owner-wallet";

const position: JupiterPerpsPosition = {
  id: "position-1",
  source: "live-api",
  platformId: "jupiter-perps",
  marketSymbol: "SOL/USD",
  marketName: "SOL",
  marketAddress: "market",
  custodyAddress: "custody",
  collateralCustodyAddress: "collateral-custody",
  collateralSymbol: "USDC",
  imageUri: null,
  side: "long",
  entryPrice: 100,
  markPrice: 101,
  positionSize: 2,
  positionValue: 202,
  collateralValue: 20,
  leverage: 10,
  unrealizedPnl: 2,
  realizedPnl: 0,
  liquidationPrice: 91,
  fundingSnapshot: null,
  borrowSnapshot: null,
  takeProfit: 110,
  stopLoss: 95,
  markPriceIsLive: true,
  liquidationPriceIsEstimated: false,
  accountRef: "position-pubkey",
  lastUpdated: Date.parse("2026-07-23T12:01:00.000Z"),
};

const execution: PerpsUserExecution = {
  executionId: "execution-1",
  sessionId: "session-1",
  walletAddress,
  signalId: "signal-1",
  symbol: "SOL/USD",
  summary: "Smart SOL entry",
  side: "long",
  asset: "SOL",
  mode: "live",
  executionModel: "delegated-ready",
  status: "submitted",
  reasonCode: "APPROVED",
  reasonMessage: "Submitted",
  collateralUsd: 20,
  sizeUsd: 200,
  leverage: 10,
  takeProfitPrice: 110,
  stopLossPrice: 95,
  txid: "tx",
  positionPubkey: "position-pubkey",
  strategyClass: "smart",
  createdAt: "2026-07-23T12:00:00.000Z",
  updatedAt: "2026-07-23T12:00:05.000Z",
};

function trigger(kind: JupiterPerpsPendingTrigger["kind"], price: number): JupiterPerpsPendingTrigger {
  return {
    id: `trigger-${kind}`,
    source: "live-api",
    platformId: "jupiter-perps",
    marketSymbol: "SOL/USD",
    marketName: "SOL",
    marketAddress: "market",
    custodyAddress: "custody",
    collateralCustodyAddress: "collateral-custody",
    collateralSymbol: "USDC",
    side: "long",
    kind,
    triggerPrice: price,
    sizeDeltaUsd: 200,
    collateralDelta: 20,
    entirePosition: true,
    triggerAboveThreshold: kind === "take-profit",
    executed: false,
    accountRef: `trigger-${kind}`,
    positionPubkey: "position-pubkey",
    positionRequestPubkey: null,
    lastUpdated: Date.parse("2026-07-23T12:00:10.000Z"),
  };
}

function exitTrade(overrides: Partial<JupiterPerpsTrade> = {}): JupiterPerpsTrade {
  return {
    id: "exit-trade",
    source: "live-api",
    positionPubkey: "position-pubkey",
    marketSymbol: "SOL/USD",
    marketName: "SOL",
    side: "long",
    action: "Close",
    orderType: "Take Profit",
    price: 110,
    sizeUsd: 220,
    collateralUsdDelta: -20,
    feeUsd: 0.25,
    pnl: 19.75,
    pnlPercentage: 98.75,
    txHash: "exit-tx",
    lastUpdated: Date.parse("2026-07-23T12:30:00.000Z"),
    createdAt: Date.parse("2026-07-23T12:30:00.000Z"),
    ...overrides,
  };
}

function snapshot(
  positions: JupiterPerpsPosition[],
  pendingTriggers: JupiterPerpsPendingTrigger[] = [],
  recentTrades: JupiterPerpsTrade[] = []
): JupiterPerpsAccountSnapshot {
  return { positions, pendingTriggers, recentTrades };
}

test("entry notification includes strategy, side, mark, sizing, TP/SL expected PnL, and liquidation", () => {
  const notification = buildTradeEntryNotification({ walletAddress, position, execution });

  assert.equal(notification.title, "Smart Long Opened · SOL");
  assert.match(notification.body, /Entry \$100\.00 · Mark \$101\.00/);
  assert.match(notification.body, /\$202\.00 position \/ \$20\.00 collateral · 10x/);
  assert.match(notification.body, /TP \$110\.00 \(\+\$20\.00\)/);
  assert.match(notification.body, /SL \$95\.00 \(-\$10\.00\)/);
  assert.match(notification.body, /Liq \$91\.00/);
  assert.equal(notification.sound, "brem_approval.wav");
});

test("entry notification identifies scalp trades", () => {
  const notification = buildTradeEntryNotification({
    walletAddress,
    position: { ...position, side: "short" },
    execution: { ...execution, side: "short", strategyClass: "scalp" },
  });

  assert.equal(notification.title, "Scalp Short Opened · SOL");
});

test("an exit near SL is not mislabeled as TP when both triggers existed", () => {
  const recentTrades = [exitTrade({ orderType: "Close", price: 95.01, pnl: -10.2 })];
  const reason = inferTradeExitReason({
    position,
    previousTriggers: [trigger("take-profit", 110), trigger("stop-loss", 95)],
    recentTrades,
    execution,
  });

  assert.equal(reason, "stop-loss");
  const notification = buildTradeExitNotification({
    walletAddress,
    position,
    previousTriggers: [trigger("take-profit", 110), trigger("stop-loss", 95)],
    recentTrades,
    execution,
  });
  assert.equal(notification.title, "SL Hit · Smart SOL Long");
  assert.match(notification.body, /Exit \$95\.01 · P&L -\$10\.20/);
  assert.equal(notification.sound, "brem_sl.wav");
});

test("TP and liquidation exits receive distinct titles and sounds", () => {
  const tp = buildTradeExitNotification({
    walletAddress,
    position,
    previousTriggers: [trigger("take-profit", 110), trigger("stop-loss", 95)],
    recentTrades: [exitTrade()],
    execution,
  });
  const liquidation = buildTradeExitNotification({
    walletAddress,
    position,
    previousTriggers: [trigger("take-profit", 110), trigger("stop-loss", 95)],
    recentTrades: [exitTrade({
      action: "Liquidate",
      orderType: "Market",
      price: 91,
      pnl: -20,
    })],
    execution,
  });

  assert.equal(tp.title, "TP Hit · Smart SOL Long");
  assert.equal(tp.sound, "brem_tp.wav");
  assert.equal(liquidation.title, "Liquidated · Smart SOL Long");
  assert.equal(liquidation.sound, "brem_sl.wav");
});

test("lifecycle comparison emits each entry or exit once and ignores unchanged positions", () => {
  const opened = buildTradeLifecycleNotifications({
    walletAddress,
    previousSnapshot: snapshot([]),
    currentSnapshot: snapshot([position]),
    executions: [execution],
  });
  const unchanged = buildTradeLifecycleNotifications({
    walletAddress,
    previousSnapshot: snapshot([position]),
    currentSnapshot: snapshot([position]),
    executions: [execution],
  });
  const closed = buildTradeLifecycleNotifications({
    walletAddress,
    previousSnapshot: snapshot([position], [trigger("take-profit", 110), trigger("stop-loss", 95)]),
    currentSnapshot: snapshot([], [], [exitTrade()]),
    executions: [execution],
  });

  assert.equal(opened.length, 1);
  assert.equal(unchanged.length, 0);
  assert.equal(closed.length, 1);
  assert.match(closed[0]?.title ?? "", /^TP Hit/);
});
