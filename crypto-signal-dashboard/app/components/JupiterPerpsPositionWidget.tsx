"use client";

import { useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { clusterApiUrl } from "@solana/web3.js";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";

import { useJupiterPerpsPositions } from "@/hooks/useJupiterPerpsPositions";
import { formatUsd } from "@/lib/utils";
import { shortenWalletAddress, type JupiterPerpsPosition } from "@/lib/jupiterPerps";

function formatNumber(value: number | null, maximumFractionDigits = 2) {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}x`;
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

function ReadOnlyWalletProvider({ children }: PropsWithChildren) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || clusterApiUrl("mainnet-beta");
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
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

function PositionCard({ position }: { position: JupiterPerpsPosition }) {
  const pnlValue = position.unrealizedPnl;
  const isPositive = typeof pnlValue === "number" && pnlValue > 0;
  const isNegative = typeof pnlValue === "number" && pnlValue < 0;

  return (
    <article className="perps-position-card">
      <div className="perps-position-head">
        <div>
          <div className="perps-position-symbol-row">
            <strong>{position.marketSymbol}</strong>
            <span className={`perps-side-badge ${position.side === "long" ? "long" : "short"}`}>
              {position.side === "long" ? "Long" : "Short"}
            </span>
          </div>
          <div className="subtext">{position.marketName ?? "Jupiter Perps position"}</div>
        </div>
        <div className="perps-position-price">
          <span className="subtext">Mark</span>
          <strong>{position.markPrice === null ? "-" : formatUsd(position.markPrice)}</strong>
        </div>
      </div>

      <div className="perps-metric-grid">
        <PositionMetric label="Entry" value={position.entryPrice === null ? "-" : formatUsd(position.entryPrice)} />
        <PositionMetric label="Size" value={formatNumber(position.positionSize, 4)} />
        <PositionMetric label="Value" value={position.positionValue === null ? "-" : formatUsd(position.positionValue)} />
        <PositionMetric label="Collateral" value={position.collateralValue === null ? "-" : formatUsd(position.collateralValue)} />
        <PositionMetric label="Leverage" value={formatPercent(position.leverage)} />
        <PositionMetric
          label="Unrealized PnL"
          value={position.unrealizedPnl === null ? "-" : formatUsd(position.unrealizedPnl)}
          positive={isPositive}
          negative={isNegative}
        />
        <PositionMetric
          label="Liquidation"
          value={position.liquidationPrice === null ? "-" : formatUsd(position.liquidationPrice)}
        />
        <PositionMetric label="Realized PnL" value={position.realizedPnl === null ? "-" : formatUsd(position.realizedPnl)} />
      </div>

      <div className="perps-position-footer">
        <span className="subtext">Updated {formatTimestamp(position.lastUpdated)}</span>
        <span className="subtext">
          Funding/Borrow {position.borrowSnapshot ?? position.fundingSnapshot ?? "Not exposed by the current Portfolio API"}
        </span>
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

function JupiterPerpsPositionWidgetBody() {
  const {
    publicKey,
    connected,
    connecting,
    disconnecting,
    wallets,
    wallet,
    select,
    connect,
    disconnect,
  } = useWallet();
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [selectedWalletName, setSelectedWalletName] = useState<WalletName<string> | null>(null);
  const [walletFeedback, setWalletFeedback] = useState<string | null>(null);
  const [showMockData, setShowMockData] = useState(process.env.NEXT_PUBLIC_JUPITER_PERPS_DEMO === "true");

  const walletAddress = publicKey?.toBase58() ?? null;
  const { positions, isLoading, error, isMock, refetch } = useJupiterPerpsPositions({
    walletAddress,
    showMockData,
  });

  const visibleWallets = useMemo(() => {
    const preferred = ["Phantom", "Solflare"];
    return [...wallets]
      .filter((entry) => entry.readyState !== "Unsupported")
      .sort((left, right) => {
        const leftScore = preferred.indexOf(left.adapter.name);
        const rightScore = preferred.indexOf(right.adapter.name);
        return (leftScore === -1 ? 99 : leftScore) - (rightScore === -1 ? 99 : rightScore);
      });
  }, [wallets]);

  useEffect(() => {
    if (!selectedWalletName || wallet?.adapter.name !== selectedWalletName) return;

    let cancelled = false;

    async function runConnect() {
      try {
        setWalletFeedback("Connecting wallet...");
        await connect();
        if (!cancelled) {
          setWalletFeedback(null);
          setWalletMenuOpen(false);
        }
      } catch (connectError) {
        if (cancelled) return;
        const message = connectError instanceof Error ? connectError.message : "Wallet connection was not completed.";
        setWalletFeedback(message);
      } finally {
        if (!cancelled) {
          setSelectedWalletName(null);
        }
      }
    }

    void runConnect();

    return () => {
      cancelled = true;
    };
  }, [connect, selectedWalletName, wallet?.adapter.name]);

  async function handleWalletPick(name: WalletName<string>, readyState: WalletReadyState) {
    if (readyState === "NotDetected") {
      setWalletFeedback("Wallet extension not detected. Install Phantom or Solflare, then try again.");
      return;
    }

    setWalletFeedback(null);
    setSelectedWalletName(name);
    select(name);
  }

  async function handleDisconnect() {
    try {
      await disconnect();
      setWalletFeedback("Wallet disconnected.");
    } catch (disconnectError) {
      const message = disconnectError instanceof Error ? disconnectError.message : "Unable to disconnect the wallet.";
      setWalletFeedback(message);
    }
  }

  const shouldShowDisconnectedState = !connected && !showMockData && positions.length === 0;
  const hasNoPositions = connected && !isLoading && !error && positions.length === 0;

  return (
    <div className="perps-widget-shell">
      <div className="perps-widget-header">
        <div>
          <div className="perps-widget-title-row">
            <strong>Jupiter Perps</strong>
            <span className="perps-readonly-badge">Read-only</span>
            {isMock ? <span className="perps-demo-badge">Demo</span> : null}
          </div>
          <div className="subtext">
            Connect a Solana wallet to view Jupiter Perps positions without signing trades or moving funds.
          </div>
        </div>
        <div className="wallet-controls perps-widget-actions">
          {connected ? (
            <>
              <button type="button" className="secondary" onClick={() => void refetch()} disabled={isLoading}>
                {isLoading ? "Refreshing..." : "Refresh"}
              </button>
              <button type="button" onClick={() => void handleDisconnect()} disabled={disconnecting}>
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setWalletMenuOpen((open) => !open)} disabled={connecting}>
                {connecting ? "Connecting..." : "Connect Wallet"}
              </button>
              <button type="button" className="secondary" onClick={() => setShowMockData((value) => !value)}>
                {showMockData ? "Hide Demo" : "Preview Demo"}
              </button>
            </>
          )}
        </div>
      </div>

      {connected ? (
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

      {walletMenuOpen && !connected ? (
        <div className="perps-wallet-picker" role="dialog" aria-label="Select a Solana wallet">
          <div className="perps-wallet-picker-header">
            <strong>Choose wallet</strong>
            <button type="button" className="secondary" onClick={() => setWalletMenuOpen(false)}>
              Close
            </button>
          </div>
          <div className="perps-wallet-grid">
            {visibleWallets.length === 0 ? (
              <div className="perps-message-card">
                <strong>No supported wallet found</strong>
                <span className="subtext">Install Phantom or Solflare to connect a wallet in read-only mode.</span>
              </div>
            ) : (
              visibleWallets.map((entry) => (
                <button
                  key={entry.adapter.name}
                  type="button"
                  className="perps-wallet-option"
                  onClick={() => void handleWalletPick(entry.adapter.name, entry.readyState)}
                >
                  <span>{entry.adapter.name}</span>
                  <span className="subtext">{getWalletReadinessLabel(entry.readyState)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {walletFeedback ? (
        <div className="perps-inline-banner" role="status">
          {walletFeedback}
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

      <div className="perps-widget-body">
        {isLoading ? <LoadingState /> : null}

        {!isLoading && shouldShowDisconnectedState ? (
          <div className="perps-empty-state">
            <strong>Connect a Solana wallet</strong>
            <span className="subtext">
              This Level 1 widget only reads positions. It does not create orders, request trade signatures, or move funds.
            </span>
          </div>
        ) : null}

        {!isLoading && hasNoPositions ? (
          <div className="perps-empty-state">
            <strong>No open Jupiter Perps positions found.</strong>
            <span className="subtext">If this wallet opens a Jupiter Perps position later, it will appear here on refresh.</span>
          </div>
        ) : null}

        {!isLoading && positions.length > 0 ? (
          <div className="perps-list">
            {positions.map((position) => (
              <PositionCard key={position.id} position={position} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="perps-widget-footnote">
        Data source: Jupiter Portfolio API leverage elements. Lower-level Jupiter Perps account parsing is intentionally left as a documented placeholder until the official Perps docs / IDL are fully confirmed.
      </div>
    </div>
  );
}

export function JupiterPerpsPositionWidget() {
  return (
    <ReadOnlyWalletProvider>
      <JupiterPerpsPositionWidgetBody />
    </ReadOnlyWalletProvider>
  );
}
