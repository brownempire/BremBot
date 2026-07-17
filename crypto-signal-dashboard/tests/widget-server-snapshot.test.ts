import assert from "node:assert/strict";
import test from "node:test";

import type { JupiterPerpsPosition } from "../lib/jupiterPerps";
import type { PerpsAutomationSession } from "../lib/perps/sessionTypes";
import { buildWidgetServerSnapshot } from "../lib/widget/serverSnapshot";

const liveSession: PerpsAutomationSession = {
  sessionId: "session-widget",
  walletAddress: "private-owner-address",
  sessionState: "clocked_in",
  startedAt: "2026-07-16T12:00:00.000Z",
  lastHeartbeatAt: "2026-07-16T12:00:00.000Z",
  inactiveSince: null,
  endedAt: null,
  mode: "live",
  executionModel: "delegated-ready",
  appOpen: false,
  appForeground: false,
  walletConnected: true,
  walletWriteEnabled: true,
  killSwitch: false,
  unlimitedSession: true,
  platform: "native",
  walletProvider: "Jupiter Mobile",
  warning: null,
};

const position: JupiterPerpsPosition = {
  id: "private-position-id",
  source: "live-api",
  platformId: "jupiter-perps",
  marketSymbol: "SOL/USD",
  marketName: "SOL",
  marketAddress: "private-market-address",
  custodyAddress: "private-custody-address",
  collateralCustodyAddress: "private-collateral-address",
  collateralSymbol: "USDC",
  imageUri: null,
  side: "long",
  entryPrice: 150,
  markPrice: 155,
  positionSize: 2,
  positionValue: 310,
  collateralValue: 100,
  leverage: 3.1,
  unrealizedPnl: 10,
  realizedPnl: 0,
  liquidationPrice: 120,
  fundingSnapshot: null,
  borrowSnapshot: null,
  takeProfit: 175,
  stopLoss: 135,
  markPriceIsLive: true,
  liquidationPriceIsEstimated: false,
  accountRef: "private-account-ref",
  lastUpdated: 1_752_667_200_000,
};

test("widget summary contains display-safe position data and agent equity", () => {
  const snapshot = buildWidgetServerSnapshot({
    agentPositions: [position],
    mainAvailableUsdc: 75,
    agentAvailableUsdc: 250,
    session: liveSession,
    now: new Date("2026-07-16T12:34:56.000Z"),
  });

  assert.equal(snapshot.openPerpLabel, "SOL/USD LONG");
  assert.match(snapshot.openPerpDetail, /\$310\.00 position/);
  assert.equal(snapshot.openPerpPnlUsd, 10);
  assert.equal(snapshot.openPerpPnlPercent, 10);
  assert.equal(snapshot.openPerpMarket, "SOL/USD");
  assert.equal(snapshot.openPerpSide, "long");
  assert.equal(snapshot.openPerpPositionValueUsd, 310);
  assert.equal(snapshot.openPerpCollateralUsd, 100);
  assert.equal(snapshot.openPerpEntryPrice, 150);
  assert.equal(snapshot.openPerpMarkPrice, 155);
  assert.equal(snapshot.openPerpLeverage, 3.1);
  assert.equal(snapshot.openPerpLiquidationPrice, 120);
  assert.equal(snapshot.openPerpTakeProfitPrice, 175);
  assert.equal(snapshot.openPerpStopLossPrice, 135);
  assert.equal(snapshot.walletBalanceUsd, 360);
  assert.equal(snapshot.mainWalletBalanceUsd, 75);
  assert.equal(snapshot.agentWalletBalanceUsd, 360);
  assert.equal(snapshot.perpsSessionState, "Clocked In");
  assert.equal(snapshot.perpsMode, "Live mode");
  assert.equal(snapshot.perpsExecutionModel, "delegated-ready");
  assert.equal(snapshot.updatedAt, 1_784_205_296);

  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /private-owner-address/);
  assert.doesNotMatch(encoded, /private-position-id/);
  assert.doesNotMatch(encoded, /private-account-ref/);
  assert.doesNotMatch(encoded, /private-market-address/);
});

test("widget summary provides a useful idle state without inventing a balance", () => {
  const snapshot = buildWidgetServerSnapshot({
    agentPositions: [],
    mainAvailableUsdc: null,
    agentAvailableUsdc: null,
    session: null,
    now: new Date("2026-07-16T00:00:00.000Z"),
  });

  assert.equal(snapshot.openPerpLabel, "No open perps");
  assert.equal(snapshot.openPerpDetail, "Agent is monitoring for the next setup.");
  assert.equal(snapshot.openPerpPnlUsd, null);
  assert.equal(snapshot.openPerpMarket, null);
  assert.equal(snapshot.openPerpEntryPrice, null);
  assert.equal(snapshot.walletBalanceUsd, null);
  assert.equal(snapshot.mainWalletBalanceUsd, null);
  assert.equal(snapshot.agentWalletBalanceUsd, null);
  assert.equal(snapshot.perpsSessionState, "Clocked Out");
  assert.equal(snapshot.perpsMode, "Paper mode");
});

test("mock positions are never exposed by the production widget summary", () => {
  const snapshot = buildWidgetServerSnapshot({
    agentPositions: [{ ...position, source: "mock" }],
    mainAvailableUsdc: 10,
    agentAvailableUsdc: 25,
    session: liveSession,
  });

  assert.equal(snapshot.openPerpLabel, "No open perps");
  assert.equal(snapshot.openPerpPnlUsd, null);
  assert.equal(snapshot.walletBalanceUsd, 25);
  assert.equal(snapshot.mainWalletBalanceUsd, 10);
  assert.equal(snapshot.agentWalletBalanceUsd, 25);
});

test("main wallet value includes equity from primary-wallet Perps positions", () => {
  const snapshot = buildWidgetServerSnapshot({
    agentPositions: [],
    mainPositions: [{ ...position, collateralValue: 50, unrealizedPnl: -5 }],
    mainAvailableUsdc: 100,
    agentAvailableUsdc: 20,
    session: liveSession,
  });

  assert.equal(snapshot.mainWalletBalanceUsd, 145);
  assert.equal(snapshot.agentWalletBalanceUsd, 20);
  assert.equal(snapshot.openPerpLabel, "SOL/USD LONG");
});
