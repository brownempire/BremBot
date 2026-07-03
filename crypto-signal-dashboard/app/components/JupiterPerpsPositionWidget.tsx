"use client";

import { Browser } from "@capacitor/browser";
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { Capacitor } from "@capacitor/core";
import { clusterApiUrl } from "@solana/web3.js";
import { useWrappedReownAdapter } from "@jup-ag/jup-mobile-adapter";
import {
  WalletReadyState,
  useWallet,
  type Adapter,
  type WalletName,
} from "@jup-ag/wallet-adapter";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";

import { useJupiterPerpsPositions } from "@/hooks/useJupiterPerpsPositions";
import { formatUsd } from "@/lib/utils";
import {
  shortenWalletAddress,
  type JupiterPerpsPendingTrigger,
  type JupiterPerpsPosition,
} from "@/lib/jupiterPerps";

export type JupiterPerpsWidgetSnapshot = {
  walletAddress: string | null;
  positions: JupiterPerpsPosition[];
  pendingTriggers: JupiterPerpsPendingTrigger[];
  isLoading: boolean;
  error: string | null;
  isMock: boolean;
  connected: boolean;
};

type NativeJupiterContextValue = {
  connectJupiterMobile: (() => Promise<void>) | null;
  directAdapterLabel: string | null;
};

const NativeJupiterContext = createContext<NativeJupiterContextValue>({
  connectJupiterMobile: null,
  directAdapterLabel: null,
});

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

function JupiterNativeWalletProvider({
  children,
  endpoint,
  reownProjectId,
}: PropsWithChildren<{
  endpoint: string;
  reownProjectId: string;
}>) {
  const { jupiterAdapter } = useWrappedReownAdapter({
    appKitOptions: {
      metadata: {
        name: "BremLogic",
        description: "BremLogic Signals Bot read-only Jupiter Perps wallet connection",
        url: "https://app.bremlogic.com",
        icons: ["https://app.bremlogic.com/favicon.ico"],
      },
      projectId: reownProjectId,
      features: {
        analytics: false,
        socials: ["google", "x", "apple"],
        email: false,
      },
      enableWallets: false,
    },
  });

  const nativeWallets = useMemo<Adapter[]>(() => {
    return [jupiterAdapter].filter((item) => item && item.name && item.icon) as Adapter[];
  }, [jupiterAdapter]);
  const nativeAdapterContextValue = useMemo<NativeJupiterContextValue>(() => ({
    connectJupiterMobile: async () => {
      await jupiterAdapter.connect();
    },
    directAdapterLabel: typeof jupiterAdapter.name === "string" ? jupiterAdapter.name : "Jupiter Mobile",
  }), [jupiterAdapter]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={nativeWallets} autoConnect={false}>
        <NativeJupiterContext.Provider value={nativeAdapterContextValue}>
          {children}
        </NativeJupiterContext.Provider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function ReadOnlyWalletProvider({ children }: PropsWithChildren) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() || clusterApiUrl("mainnet-beta");
  const nativeShell = typeof window !== "undefined" && Capacitor.isNativePlatform();
  const reownProjectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim() ?? "";
  const shouldUseJupiterNativeAdapter = nativeShell && reownProjectId.length > 0;

  return (
    shouldUseJupiterNativeAdapter ? (
      <JupiterNativeWalletProvider endpoint={endpoint} reownProjectId={reownProjectId}>
        {children}
      </JupiterNativeWalletProvider>
    ) : (
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={[]} autoConnect={false}>
          {children}
        </WalletProvider>
      </ConnectionProvider>
    )
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
        <PositionMetric label="Pending TP" value={position.takeProfit === null ? "-" : formatUsd(position.takeProfit)} />
        <PositionMetric label="Pending SL" value={position.stopLoss === null ? "-" : formatUsd(position.stopLoss)} />
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
  const { connectJupiterMobile, directAdapterLabel } = useContext(NativeJupiterContext);
  const {
    publicKey,
    connected: adapterConnected,
    connecting: adapterConnecting,
    disconnecting: adapterDisconnecting,
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
  const nativeShell = typeof window !== "undefined" && Capacitor.isNativePlatform();
  const reownProjectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim() ?? "";
  const mobileUserAgent = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const shouldRecommendJupiterMobile = nativeShell || mobileUserAgent;
  const nativeJupiterAdapterEnabled = nativeShell && reownProjectId.length > 0;

  const isConnected = adapterConnected;
  const isConnecting = adapterConnecting;
  const isDisconnecting = adapterDisconnecting;
  const walletAddress = publicKey?.toBase58() ?? null;
  const { positions, pendingTriggers, isLoading, error, isMock, refetch } = useJupiterPerpsPositions({
    walletAddress,
    showMockData,
  });

  const visibleWallets = useMemo(() => {
    return [...wallets]
      .filter((entry) => entry.readyState !== "Unsupported")
      .filter((entry) => String(entry.adapter.name).toLowerCase().includes("jupiter"));
  }, [wallets]);
  const nativeJupiterWallet = useMemo(
    () => visibleWallets.find((entry) => String(entry.adapter.name).toLowerCase().includes("jupiter")) ?? null,
    [visibleWallets]
  );

  useEffect(() => {
    onSnapshotChange?.({
      walletAddress,
      positions,
      pendingTriggers,
      isLoading,
      error,
      isMock,
      connected: isConnected,
    });
  }, [error, isConnected, isLoading, isMock, onSnapshotChange, pendingTriggers, positions, walletAddress]);

  useEffect(() => {
    if (isConnected) {
      setWalletMenuOpen(false);
      setWalletFeedback(null);
    }
  }, [isConnected]);

  function openJupiterExperience() {
    if (typeof window === "undefined") return;

    if (nativeShell) {
      void Browser.open({ url: "https://jup.ag" });
      return;
    }

    window.location.assign("https://jup.ag");
  }

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
    if (nativeShell && !nativeJupiterAdapterEnabled) {
      setWalletFeedback("Jupiter Mobile adapter is not configured for the native app yet. Add NEXT_PUBLIC_REOWN_PROJECT_ID to enable direct Jupiter Mobile connection.");
      return;
    }

    if (readyState === "NotDetected") {
      setWalletFeedback("No compatible wallet was detected in this browser. Open BremLogic inside Jupiter Mobile's dApp browser, or install a supported wallet and try again.");
      return;
    }

    setWalletFeedback(null);
    setSelectedWalletName(name);
    select(name);
  }

  async function handleNativeJupiterConnect() {
    if (!nativeJupiterAdapterEnabled) {
      setWalletFeedback("Jupiter Mobile adapter is not configured for the native app yet. Add NEXT_PUBLIC_REOWN_PROJECT_ID to enable direct Jupiter Mobile connection.");
      return;
    }

    if (!connectJupiterMobile) {
      setWalletFeedback("Jupiter Mobile's direct adapter is not ready yet in this session. Close the wallet picker and try again.");
      return;
    }

    try {
      setWalletFeedback("Opening Jupiter Mobile...");
      await connectJupiterMobile();
      setWalletFeedback(null);
      setWalletMenuOpen(false);
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : "Jupiter Mobile connection was not completed.";
      setWalletFeedback(message);
    }
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
                ? "BremLogic native app is configured to use Jupiter's official Mobile Adapter. Selecting Jupiter should route through Jupiter Mobile's supported WalletConnect flow."
                : "Jupiter Mobile works best when BremLogic is opened inside Jupiter Mobile's dApp browser. External app handoffs from the native iPhone shell may still leave you in a mobile browser unless the native Jupiter Mobile Adapter is configured."}
            </div>
          ) : null}
          {nativeShell && nativeJupiterAdapterEnabled ? (
            <div className="perps-wallet-grid">
              <div className="perps-message-card">
                <strong>Connect with Jupiter Mobile</strong>
                <span className="subtext">
                  Use Jupiter&apos;s direct mobile adapter path. This should target Jupiter Mobile itself instead of falling back to the broader wallet onboarding modal.
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
                  Adapter: {nativeJupiterWallet?.adapter.name ?? directAdapterLabel ?? "Jupiter Mobile"}
                </span>
              </div>
            </div>
          ) : (
          <div className="perps-wallet-grid">
            {visibleWallets.length === 0 ? (
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
            ) : (
              visibleWallets.map((entry) => (
                <button
                  key={entry.adapter.name}
                  type="button"
                  className="perps-wallet-option"
                  onClick={() => void handleWalletPick(entry.adapter.name, entry.readyState)}
                >
                  <span>{entry.adapter.name}</span>
                  <span className="subtext">
                    {entry.adapter.name === "Jupiter"
                      ? "Recommended when using Jupiter Mobile's dApp browser"
                      : getWalletReadinessLabel(entry.readyState)}
                  </span>
                </button>
              ))
            )}
          </div>
          )}
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

        {!isLoading && hasNoPerpsState ? (
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

        {!isLoading && positions.length === 0 && pendingTriggers.length > 0 ? (
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
      </div>

      <div className="perps-widget-footnote">
        Data source: direct Jupiter Perps Position and PositionRequest account reads over Solana RPC, with Jupiter&apos;s Portfolio API used only as a fallback if the live account read cannot complete.
      </div>
    </div>
  );
}

export function JupiterPerpsPositionWidget({
  onSnapshotChange,
}: {
  onSnapshotChange?: (snapshot: JupiterPerpsWidgetSnapshot) => void;
}) {
  return (
    <ReadOnlyWalletProvider>
      <JupiterPerpsPositionWidgetBody onSnapshotChange={onSnapshotChange} />
    </ReadOnlyWalletProvider>
  );
}
