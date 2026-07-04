"use client";

import { Browser } from "@capacitor/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { WalletReadyState } from "@jup-ag/wallet-adapter";

import { useJupiterPerpsClosePosition } from "@/hooks/useJupiterPerpsClosePosition";
import { useJupiterPerpsPositions } from "@/hooks/useJupiterPerpsPositions";
import { useNativeJupiterWalletConnect } from "@/hooks/useNativeJupiterWalletConnect";
import { formatUsd } from "@/lib/utils";
import {
  shortenWalletAddress,
  type JupiterPerpsTrade,
  type JupiterPerpsPendingTrigger,
  type JupiterPerpsPosition,
} from "@/lib/jupiterPerps";

export type JupiterPerpsWidgetSnapshot = {
  walletAddress: string | null;
  positions: JupiterPerpsPosition[];
  pendingTriggers: JupiterPerpsPendingTrigger[];
  recentTrades: JupiterPerpsTrade[];
  isLoading: boolean;
  error: string | null;
  isMock: boolean;
  connected: boolean;
};

function formatNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}x`;
}

function formatSignedUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

function formatTimestamp(timestamp: number | null) {
  if (!timestamp) return "Unavailable";
  return new Date(timestamp).toLocaleString();
}

function getWalletReadinessLabel(readyState: WalletReadyState) {
  switch (readyState) {
    case "Installed":
      return "Installed";
    case "Loadable":
      return "Available";
    case "NotDetected":
      return "Not detected";
    default:
      return "Unsupported";
  }
}

function getCloseReceiveToken(position: JupiterPerpsPosition): "BTC" | "ETH" | "SOL" | "USDC" {
  if (position.collateralSymbol === "BTC" || position.collateralSymbol === "ETH" || position.collateralSymbol === "SOL") {
    return position.collateralSymbol;
  }

  return "USDC";
}

function PositionMetric({
  label,
  value,
  positive,
  negative,
}: {
  label: string;
  value: string;
  positive?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="perps-metric">
      <span>{label}</span>
      <strong className={positive ? "pnl-positive" : negative ? "pnl-negative" : undefined}>{value}</strong>
    </div>
  );
}

function PositionCard({
  closingPositionPubkey,
  onClosePosition,
  pendingClosePositionPubkeys,
  position,
  writeEnabled,
}: {
  closingPositionPubkey: string | null;
  onClosePosition: (position: JupiterPerpsPosition) => Promise<void>;
  pendingClosePositionPubkeys: Set<string>;
  position: JupiterPerpsPosition;
  writeEnabled: boolean;
}) {
  const pnlValue = position.unrealizedPnl;
  const isPositive = typeof pnlValue === "number" && pnlValue > 0;
  const isNegative = typeof pnlValue === "number" && pnlValue < 0;
  const closePubkey = position.accountRef;
  const showCloseButton = position.source !== "mock";
  const canClose = writeEnabled && typeof closePubkey === "string" && closePubkey.length > 0;
  const isSubmitting = closePubkey !== null && closingPositionPubkey === closePubkey;
  const isPendingKeeper = closePubkey !== null && pendingClosePositionPubkeys.has(closePubkey);

  return (
    <article className="perps-position-card">
      <div className="perps-position-head">
        <div className="perps-position-meta">
          <div className="perps-position-symbol-row">
            <strong>{position.marketSymbol}</strong>
            <span className={`perps-side-badge ${position.side === "long" ? "long" : "short"}`}>
              {position.side === "long" ? "Long" : "Short"}
            </span>
          </div>
          <div className="subtext">{position.marketName ?? "Jupiter Perps position"}</div>
        </div>
        {showCloseButton ? (
          <div className="perps-position-close">
            <button
              type="button"
              className="secondary perps-close-button"
              disabled={!canClose || isSubmitting || isPendingKeeper}
              onClick={() => void onClosePosition(position)}
            >
              {isSubmitting ? "Requesting close..." : isPendingKeeper ? "Close requested..." : "Close Position"}
            </button>
          </div>
        ) : null}
        <div className="perps-position-price">
          <span className="subtext">Mark{position.markPriceIsLive ? " (live)" : ""}</span>
          <strong>{position.markPrice === null ? "-" : formatUsd(position.markPrice)}</strong>
        </div>
      </div>

      <div className="perps-metric-grid">
        <PositionMetric label="Entry" value={position.entryPrice === null ? "-" : formatUsd(position.entryPrice)} />
        <PositionMetric label="Size" value={formatNumber(position.positionSize, 4)} />
        <PositionMetric label="Value" value={position.positionValue === null ? "-" : formatUsd(position.positionValue)} />
        <PositionMetric label="Collateral" value={position.collateralValue === null ? "-" : formatUsd(position.collateralValue)} />
        <PositionMetric label="Leverage" value={formatPercent(position.leverage)} />
        <PositionMetric label="Pending TP" value={position.takeProfit === null ? "-" : formatUsd(position.takeProfit)} />
        <PositionMetric label="Pending SL" value={position.stopLoss === null ? "-" : formatUsd(position.stopLoss)} />
        <PositionMetric
          label="Unrealized PnL"
          value={position.unrealizedPnl === null ? "-" : formatUsd(position.unrealizedPnl)}
          positive={isPositive}
          negative={isNegative}
        />
        <PositionMetric
          label={position.liquidationPriceIsEstimated ? "Liquidation (est.)" : "Liquidation"}
          value={position.liquidationPrice === null ? "-" : formatUsd(position.liquidationPrice)}
        />
        <PositionMetric label="Realized PnL" value={position.realizedPnl === null ? "-" : formatUsd(position.realizedPnl)} />
      </div>

      <div className="perps-position-footer">
        <span className="subtext">Updated {formatTimestamp(position.lastUpdated)}</span>
        <span className="subtext">
          Funding/Borrow {position.borrowSnapshot ?? position.fundingSnapshot ?? "Not exposed by the current live feed"}
        </span>
      </div>

      {showCloseButton ? (
        <div className="wallet-controls" style={{ marginTop: 12 }}>
          <span className="subtext">
            {canClose
              ? "Full close via Jupiter Perps API. The keeper network may take a moment to finalize it on-chain."
              : "Connect Jupiter Mobile in the native app to enable closing this position."}
          </span>
        </div>
      ) : null}

    </article>
  );
}

function PendingTriggerCard({ trigger }: { trigger: JupiterPerpsPendingTrigger }) {
  return (
    <article className="perps-trigger-card">
      <div className="perps-trigger-head">
        <div className="perps-position-symbol-row">
          <strong>{trigger.marketSymbol}</strong>
          <span className={`perps-side-badge ${trigger.side === "long" ? "long" : "short"}`}>
            {trigger.side === "long" ? "Long" : "Short"}
          </span>
          <span className={`perps-trigger-badge ${trigger.kind === "take-profit" ? "tp" : "sl"}`}>
            {trigger.kind === "take-profit" ? "TP" : "SL"}
          </span>
        </div>
        <strong>{trigger.triggerPrice === null ? "-" : formatUsd(trigger.triggerPrice)}</strong>
      </div>
      <div className="perps-trigger-meta">
        <span className="subtext">
          {trigger.entirePosition ? "Entire position" : "Partial size"}
          {trigger.sizeDeltaUsd !== null ? `, ${formatUsd(trigger.sizeDeltaUsd)} tracked` : ""}
        </span>
        <span className="subtext">Updated {formatTimestamp(trigger.lastUpdated)}</span>
      </div>
    </article>
  );
}

function TradeCard({ trade }: { trade: JupiterPerpsTrade }) {
  const pnlPositive = typeof trade.pnl === "number" && trade.pnl > 0;
  const pnlNegative = typeof trade.pnl === "number" && trade.pnl < 0;

  return (
    <article className="perps-trigger-card">
      <div className="perps-trigger-head">
        <div className="perps-position-symbol-row">
          <strong>{trade.marketSymbol}</strong>
          <span className={`perps-side-badge ${trade.side === "long" ? "long" : "short"}`}>
            {trade.side === "long" ? "Long" : "Short"}
          </span>
        </div>
        <strong>{trade.price === null ? "-" : formatUsd(trade.price)}</strong>
      </div>
      <div className="perps-trigger-meta">
        <span className="subtext">
          {trade.action} · {trade.orderType} · Size {trade.sizeUsd === null ? "-" : formatUsd(trade.sizeUsd)}
        </span>
        <span className={pnlPositive ? "subtext pnl-positive" : pnlNegative ? "subtext pnl-negative" : "subtext"}>
          Realized PnL {formatSignedUsd(trade.pnl)}
          {trade.pnlPercentage !== null ? ` (${trade.pnlPercentage.toFixed(2)}%)` : ""}
        </span>
        <span className="subtext">Updated {formatTimestamp(trade.lastUpdated)}</span>
      </div>
    </article>
  );
}

function LoadingState() {
  return (
    <div className="perps-list">
      {[0, 1].map((item) => (
        <div key={item} className="perps-skeleton-card" aria-hidden="true">
          <div className="perps-skeleton-row perps-skeleton-row-lg" />
          <div className="perps-skeleton-row perps-skeleton-row-md" />
          <div className="perps-skeleton-grid">
            {[0, 1, 2, 3].map((metric) => (
              <div key={metric} className="perps-skeleton-tile" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function JupiterPerpsPositionWidgetBody({
  onSnapshotChange,
}: {
  onSnapshotChange?: (snapshot: JupiterPerpsWidgetSnapshot) => void;
}) {
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const [isWidgetVisible, setIsWidgetVisible] = useState(true);
  const [activeTab, setActiveTab] = useState<"open" | "recent">("open");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [showMockData, setShowMockData] = useState(process.env.NEXT_PUBLIC_JUPITER_PERPS_DEMO === "true");
  const [pendingClosePositionPubkeys, setPendingClosePositionPubkeys] = useState<string[]>([]);
  const nativeShell = typeof window !== "undefined" && Capacitor.isNativePlatform();
  const reownProjectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim() ?? "";
  const mobileUserAgent = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const shouldRecommendJupiterMobile = nativeShell || mobileUserAgent;
  const nativeJupiterAdapterEnabled = nativeShell && reownProjectId.length > 0;
  const nativeJupiterWallet = useNativeJupiterWalletConnect(nativeJupiterAdapterEnabled, reownProjectId);
  const walletFeedback = nativeJupiterAdapterEnabled ? nativeJupiterWallet.feedback : null;
  const isConnected = nativeJupiterAdapterEnabled ? nativeJupiterWallet.isConnected : false;
  const isConnecting = nativeJupiterAdapterEnabled ? nativeJupiterWallet.isConnecting : false;
  const isDisconnecting = nativeJupiterAdapterEnabled ? nativeJupiterWallet.isDisconnecting : false;
  const walletAddress = nativeJupiterAdapterEnabled ? nativeJupiterWallet.walletAddress : null;
  const { positions, pendingTriggers, recentTrades, isLoading, error, isMock, refetch } = useJupiterPerpsPositions({
    walletAddress,
    showMockData,
    pollingEnabled: isWidgetVisible,
  });
  const {
    closePosition,
    closingPositionPubkey,
    error: closeError,
    clearError: clearCloseError,
  } = useJupiterPerpsClosePosition({
    signTransaction: nativeJupiterAdapterEnabled ? nativeJupiterWallet.signTransaction : undefined,
  });
  const pendingClosePositionPubkeySet = useMemo(() => new Set(pendingClosePositionPubkeys), [pendingClosePositionPubkeys]);
  const writeEnabled = nativeJupiterAdapterEnabled && isConnected && !isMock;

  useEffect(() => {
    onSnapshotChange?.({
      walletAddress,
      positions,
      pendingTriggers,
      recentTrades,
      isLoading,
      error,
      isMock,
      connected: isConnected,
    });
  }, [error, isConnected, isLoading, isMock, onSnapshotChange, pendingTriggers, positions, recentTrades, walletAddress]);

  useEffect(() => {
    const node = widgetRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsWidgetVisible(entry?.isIntersecting ?? true);
      },
      { threshold: 0.15 }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (positions.length === 0 && recentTrades.length > 0) {
      setActiveTab("recent");
      return;
    }

    if (positions.length > 0 && activeTab !== "open") {
      setActiveTab("open");
    }
  }, [activeTab, positions.length, recentTrades.length]);

  useEffect(() => {
    if (isConnected) {
      setWalletMenuOpen(false);
    }
  }, [isConnected]);

  useEffect(() => {
    setPendingClosePositionPubkeys((current) => {
      if (current.length === 0) return current;

      const activePositionPubkeys = new Set(
        positions
          .map((position) => position.accountRef)
          .filter((positionPubkey): positionPubkey is string => typeof positionPubkey === "string" && positionPubkey.length > 0)
      );
      const next = current.filter((positionPubkey) => activePositionPubkeys.has(positionPubkey));
      return next.length === current.length ? current : next;
    });
  }, [positions]);

  function openJupiterExperience() {
    if (typeof window === "undefined") return;

    if (nativeShell) {
      void Browser.open({ url: "https://jup.ag" });
      return;
    }

    window.location.assign("https://jup.ag");
  }

  async function handleNativeJupiterConnect() {
    if (!nativeJupiterAdapterEnabled) {
      return;
    }

    try {
      nativeJupiterWallet.clearFeedback();
      await nativeJupiterWallet.connect();
      setWalletMenuOpen(false);
    } catch {
      // The hook surfaces the user-friendly error state.
    }
  }

  async function handleDisconnect() {
    try {
      await nativeJupiterWallet.disconnect();
    } catch {
      // The hook surfaces the user-friendly error state.
    }
  }

  async function handleClosePosition(position: JupiterPerpsPosition) {
    const positionPubkey = position.accountRef?.trim();
    if (!positionPubkey) {
      return;
    }

    clearCloseError();

    await closePosition({
      positionPubkey,
      receiveToken: getCloseReceiveToken(position),
    });

    setPendingClosePositionPubkeys((current) => (
      current.includes(positionPubkey) ? current : [...current, positionPubkey]
    ));

    await refetch();
  }

  const shouldShowDisconnectedState =
    !isConnected &&
    !showMockData &&
    positions.length === 0 &&
    pendingTriggers.length === 0;
  const hasNoPerpsState =
    isConnected &&
    !isLoading &&
    !error &&
    positions.length === 0 &&
    pendingTriggers.length === 0;

  return (
    <div ref={widgetRef} className="perps-widget-shell">
      <div className="perps-widget-header">
        <div>
          <div className="perps-widget-title-row">
            <strong>Jupiter Perps</strong>
            <span className="perps-readonly-badge">{writeEnabled ? "Close enabled" : "Read-only"}</span>
            {isMock ? <span className="perps-demo-badge">Demo</span> : null}
          </div>
          <div className="subtext">
            Connect a Solana wallet to view Jupiter Perps positions. Native Jupiter Mobile sessions can also submit a full close request.
          </div>
        </div>
        <div className="wallet-controls perps-widget-actions">
          {isConnected ? (
            <>
              <button type="button" className="secondary" onClick={() => void refetch()} disabled={isLoading}>
                {isLoading ? "Refreshing..." : "Refresh"}
              </button>
              <button type="button" onClick={() => void handleDisconnect()} disabled={isDisconnecting}>
                {isDisconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setWalletMenuOpen((open) => !open)} disabled={isConnecting}>
                {isConnecting ? "Connecting..." : "Connect Wallet"}
              </button>
              <button type="button" className="secondary" onClick={() => setShowMockData((value) => !value)}>
                {showMockData ? "Hide Demo" : "Preview Demo"}
              </button>
            </>
          )}
        </div>
      </div>

      {isConnected ? (
        <div className="perps-wallet-status">
          <span>Connected wallet</span>
          <strong>{walletAddress ? shortenWalletAddress(walletAddress) : "-"}</strong>
        </div>
      ) : (
        <div className="perps-wallet-status">
          <span>Wallet status</span>
          <strong>{showMockData ? "Demo positions enabled" : "Disconnected"}</strong>
        </div>
      )}

      {walletMenuOpen && !isConnected ? (
        <div className="perps-wallet-picker" role="dialog" aria-label="Select a Solana wallet">
          <div className="perps-wallet-picker-header">
            <strong>Choose wallet</strong>
            <button type="button" className="secondary" onClick={() => setWalletMenuOpen(false)}>
              Close
            </button>
          </div>
          {shouldRecommendJupiterMobile ? (
            <div className="perps-wallet-note">
              {nativeJupiterAdapterEnabled
                ? "BremLogic native app is configured to use a native WalletConnect/AppKit Jupiter flow. Selecting Jupiter should route through Jupiter Mobile and return to BremLogic once the wallet approval finishes."
                : "Jupiter Mobile works best when BremLogic is opened inside Jupiter Mobile's dApp browser. External app handoffs from the native iPhone shell may still leave you in a mobile browser unless the native Jupiter Mobile Adapter is configured."}
            </div>
          ) : null}
          {nativeShell && nativeJupiterAdapterEnabled ? (
            <div className="perps-wallet-grid">
              <div className="perps-message-card">
                <strong>Connect with Jupiter Mobile</strong>
                <span className="subtext">
                  Use the native iOS WalletConnect/AppKit Jupiter path. Approve in Jupiter Mobile, then return to BremLogic so the session can finalize here.
                </span>
                <div className="wallet-controls" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="perps-wallet-option perps-wallet-option-native"
                    onClick={() => void handleNativeJupiterConnect()}
                  >
                    <span>Open Jupiter Mobile</span>
                  </button>
                </div>
                <span className="subtext" style={{ marginTop: 12 }}>
                  Adapter: Jupiter Mobile
                </span>
              </div>
            </div>
          ) : (
          <div className="perps-wallet-grid">
            <button
              type="button"
              className="perps-message-card perps-message-card-link"
              onClick={openJupiterExperience}
            >
              <strong>{nativeShell ? "Jupiter Mobile adapter unavailable" : "Jupiter wallet not found"}</strong>
              <span className="subtext">
                {nativeShell
                  ? nativeJupiterAdapterEnabled
                    ? "Jupiter Mobile did not expose a ready adapter yet. If Jupiter does not open directly from the native shell, use Jupiter Mobile's dApp browser for now."
                    : "Add NEXT_PUBLIC_REOWN_PROJECT_ID to enable Jupiter's official Mobile Adapter flow in the native app."
                  : "Open BremLogic inside Jupiter Mobile's dApp browser to connect the Jupiter wallet in read-only mode."}
              </span>
            </button>
            <button
              type="button"
              className="perps-wallet-option"
              disabled
            >
              <span>Jupiter</span>
              <span className="subtext">
                {getWalletReadinessLabel(WalletReadyState.NotDetected)}
              </span>
            </button>
          </div>
          )}
        </div>
      ) : null}

      {walletFeedback ? (
        <div className="perps-inline-banner" role="status">
          {walletFeedback}
        </div>
      ) : null}

      {closeError && !closingPositionPubkey ? (
        <div className="perps-inline-banner" role="alert">
          {closeError}
        </div>
      ) : null}

      {error && !isMock ? (
        <div className="perps-message-card" role="alert">
          <strong>Unable to load live Jupiter Perps positions</strong>
          <span className="subtext">{error}</span>
          <div className="wallet-controls">
            <button type="button" onClick={() => void refetch()} disabled={isLoading}>
              Retry
            </button>
            <button type="button" className="secondary" onClick={() => setShowMockData(true)}>
              Show Demo Data
            </button>
          </div>
        </div>
      ) : null}

      {error && isMock ? (
        <div className="perps-inline-banner" role="status">
          Live Jupiter data is unavailable right now. Showing demo positions instead.
        </div>
      ) : null}

      <div className="wallet-controls" style={{ marginTop: 2 }}>
        <button type="button" className={activeTab === "open" ? "" : "secondary"} onClick={() => setActiveTab("open")}>
          Open Trades
        </button>
        <button type="button" className={activeTab === "recent" ? "" : "secondary"} onClick={() => setActiveTab("recent")}>
          Recent Trades
        </button>
      </div>

      <div className="perps-widget-body">
        {isLoading ? <LoadingState /> : null}

        {!isLoading && activeTab === "open" && shouldShowDisconnectedState ? (
          <div className="perps-empty-state">
            <strong>Connect a Solana wallet</strong>
            <span className="subtext">
              This panel primarily reads positions. Native Jupiter Mobile sessions can also submit a full close request with an explicit wallet signature.
            </span>
          </div>
        ) : null}

        {!isLoading && activeTab === "open" && hasNoPerpsState ? (
          <div className="perps-empty-state">
            <strong>No open Jupiter Perps positions found.</strong>
            <span className="subtext">If this wallet opens a Jupiter Perps position later, it will appear here on refresh.</span>
          </div>
        ) : null}

        {!isLoading && activeTab === "open" && positions.length > 0 ? (
          <div className="perps-list">
            {positions.map((position) => (
              <PositionCard
                key={position.id}
                closingPositionPubkey={closingPositionPubkey}
                onClosePosition={handleClosePosition}
                pendingClosePositionPubkeys={pendingClosePositionPubkeySet}
                position={position}
                writeEnabled={writeEnabled}
              />
            ))}
            {pendingTriggers.length > 0 ? (
              <section className="perps-trigger-section">
                <div className="perps-trigger-section-head">
                  <strong>Pending TP / SL</strong>
                  <span className="subtext">{pendingTriggers.length} active on-chain request{pendingTriggers.length === 1 ? "" : "s"}</span>
                </div>
                <div className="perps-trigger-list">
                  {pendingTriggers.map((trigger) => (
                    <PendingTriggerCard key={trigger.id} trigger={trigger} />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {!isLoading && activeTab === "open" && positions.length === 0 && pendingTriggers.length > 0 ? (
          <div className="perps-list">
            <section className="perps-trigger-section">
              <div className="perps-trigger-section-head">
                <strong>Pending TP / SL</strong>
                <span className="subtext">No currently open positions decoded, but active trigger requests were found on-chain.</span>
              </div>
              <div className="perps-trigger-list">
                {pendingTriggers.map((trigger) => (
                  <PendingTriggerCard key={trigger.id} trigger={trigger} />
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {!isLoading && activeTab === "recent" && recentTrades.length > 0 ? (
          <div className="perps-list">
            {recentTrades.map((trade) => (
              <TradeCard key={trade.id} trade={trade} />
            ))}
          </div>
        ) : null}

        {!isLoading && activeTab === "recent" && recentTrades.length === 0 ? (
          <div className="perps-empty-state">
            <strong>No recent Jupiter Perps trades found.</strong>
            <span className="subtext">Closed positions and trigger fills will appear here after Jupiter records them on-chain.</span>
          </div>
        ) : null}
      </div>

      <div className="perps-widget-footnote">
        Data source: Jupiter&apos;s live Perps API for positions and trade history, with direct Solana RPC account reads kept as a fallback. Liquidation marked &quot;est.&quot; is derived from current on-chain position value and collateral when Jupiter&apos;s own decoded liquidation field is unavailable. Close requests use Jupiter&apos;s live Perps API transaction builder and still require an explicit wallet signature.
      </div>
    </div>
  );
}

export function JupiterPerpsPositionWidget({
  onSnapshotChange,
}: {
  onSnapshotChange?: (snapshot: JupiterPerpsWidgetSnapshot) => void;
}) {
  return <JupiterPerpsPositionWidgetBody onSnapshotChange={onSnapshotChange} />;
}
