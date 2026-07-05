"use client";

import { Browser } from "@capacitor/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { WalletReadyState } from "@jup-ag/wallet-adapter";

import { useJupiterPerpsClosePosition } from "@/hooks/useJupiterPerpsClosePosition";
import {
  useJupiterPerpsOpenPosition,
  type PerpsOrderDraft,
  type PerpsOrderPreview,
} from "@/hooks/useJupiterPerpsOpenPosition";
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

export type JupiterPerpsAutoTradeRequest = {
  asset: "BTC" | "ETH" | "SOL";
  collateralToken: "BTC" | "ETH" | "SOL" | "USDC";
  leverage: string;
  maxSlippageBps?: string;
  side: "long" | "short";
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
  uiAmount: number;
};

export type JupiterPerpsWidgetController = {
  attachTpsl: (request: {
    positionPubkey: string;
    stopLossPrice?: number | null;
    takeProfitPrice?: number | null;
  }) => Promise<{ requestPubkeys: string[]; txid: string }>;
  canWrite: boolean;
  connected: boolean;
  openMarketPosition: (request: JupiterPerpsAutoTradeRequest) => Promise<{ positionPubkey: string | null; txid: string }>;
  previewMarketPosition: (request: JupiterPerpsAutoTradeRequest) => Promise<PerpsOrderPreview>;
  refresh: () => Promise<void>;
  walletAddress: string | null;
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

function estimateTriggerPnl(position: JupiterPerpsPosition, triggerPrice: number | null) {
  if (
    triggerPrice === null ||
    position.entryPrice === null ||
    position.positionSize === null ||
    !Number.isFinite(triggerPrice) ||
    !Number.isFinite(position.entryPrice) ||
    !Number.isFinite(position.positionSize)
  ) {
    return null;
  }

  const priceDelta = position.side === "long"
    ? triggerPrice - position.entryPrice
    : position.entryPrice - triggerPrice;

  const estimatedPnl = priceDelta * position.positionSize;
  return Number.isFinite(estimatedPnl) ? Number(estimatedPnl.toFixed(2)) : null;
}

const MIN_TPSL_EXPECTED_PNL_USD = 1;

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

const PERPS_ASSET_OPTIONS = [
  { value: "SOL", label: "SOL" },
  { value: "ETH", label: "ETH" },
  { value: "BTC", label: "BTC" },
] as const;

const PERPS_INPUT_TOKEN_OPTIONS = [
  { value: "USDC", label: "USDC" },
  { value: "SOL", label: "SOL" },
  { value: "ETH", label: "ETH" },
  { value: "BTC", label: "BTC" },
] as const;

type PerpsAsset = (typeof PERPS_ASSET_OPTIONS)[number]["value"];
type PerpsInputToken = (typeof PERPS_INPUT_TOKEN_OPTIONS)[number]["value"];

function tokenDecimals(token: PerpsInputToken) {
  if (token === "USDC") return 6;
  if (token === "SOL") return 9;
  return 8;
}

function uiAmountToAtomicString(uiAmount: string, token: PerpsInputToken) {
  const numeric = Number(uiAmount);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const scaled = Math.floor(numeric * 10 ** tokenDecimals(token));
  return scaled > 0 ? String(scaled) : null;
}

function uiNumberAmountToAtomicString(uiAmount: number, token: PerpsInputToken) {
  if (!Number.isFinite(uiAmount) || uiAmount <= 0) return null;
  const scaled = Math.floor(uiAmount * 10 ** tokenDecimals(token));
  return scaled > 0 ? String(scaled) : null;
}

function formatPercentNumber(value: number | null, fractionDigits = 2, suffix = "%") {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(fractionDigits)}${suffix}`;
}

function formatEditableUsdPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  return value.toFixed(2);
}

function getPerpsTpslReceiveToken(position: JupiterPerpsPosition): "BTC" | "ETH" | "SOL" | "USDC" {
  if (position.collateralSymbol === "BTC" || position.collateralSymbol === "ETH" || position.collateralSymbol === "SOL") {
    return position.collateralSymbol;
  }

  return "USDC";
}

function getPerpsPositionMatchKey(parts: {
  custodyAddress: string | null;
  collateralCustodyAddress: string | null;
  side: JupiterPerpsPosition["side"];
}) {
  return `${parts.custodyAddress ?? "unknown-custody"}:${parts.collateralCustodyAddress ?? "unknown-collateral"}:${parts.side}`;
}

function doesTriggerBelongToPosition(position: JupiterPerpsPosition, trigger: JupiterPerpsPendingTrigger) {
  const positionPubkey = position.accountRef?.trim();
  const triggerPositionPubkey = trigger.positionPubkey?.trim();

  if (positionPubkey && triggerPositionPubkey && positionPubkey === triggerPositionPubkey) {
    return true;
  }

  return getPerpsPositionMatchKey(position) === getPerpsPositionMatchKey(trigger);
}

function validatePerpsTriggerPrice(kind: "tp" | "sl", position: JupiterPerpsPosition, triggerPrice: number) {
  const entryPrice = position.entryPrice;
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    return "Enter a valid trigger price above 0.";
  }

  if (typeof entryPrice !== "number" || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return null;
  }

  if (position.side === "long") {
    if (kind === "tp" && triggerPrice <= entryPrice) {
      return `Take profit must be above the entry price of ${formatUsd(entryPrice)} for a long position.`;
    }

    if (kind === "sl" && triggerPrice >= entryPrice) {
      return `Stop loss must be below the entry price of ${formatUsd(entryPrice)} for a long position.`;
    }
  } else {
    if (kind === "tp" && triggerPrice >= entryPrice) {
      return `Take profit must be below the entry price of ${formatUsd(entryPrice)} for a short position.`;
    }

    if (kind === "sl" && triggerPrice <= entryPrice) {
      return `Stop loss must be above the entry price of ${formatUsd(entryPrice)} for a short position.`;
    }
  }

  return null;
}

function NewPerpComposer({
  buildPreview,
  connected,
  error,
  isPreviewing,
  isSubmitting,
  onBack,
  onPlaced,
  openPosition,
  walletAddress,
  writeEnabled,
}: {
  buildPreview: (draft: PerpsOrderDraft) => Promise<PerpsOrderPreview>;
  connected: boolean;
  error: string | null;
  isPreviewing: boolean;
  isSubmitting: boolean;
  onBack: () => void;
  onPlaced: () => Promise<void>;
  openPosition: (draft: PerpsOrderDraft) => Promise<{ preview: PerpsOrderPreview; txid: string }>;
  walletAddress: string | null;
  writeEnabled: boolean;
}) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [asset, setAsset] = useState<PerpsAsset>("SOL");
  const [inputToken, setInputToken] = useState<PerpsInputToken>("USDC");
  const [amount, setAmount] = useState("10");
  const [leverage, setLeverage] = useState("10");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [maxSlippageBps, setMaxSlippageBps] = useState("100");
  const [enableTpSl, setEnableTpSl] = useState(false);
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [preview, setPreview] = useState<PerpsOrderPreview | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const canSign = connected && writeEnabled && !!walletAddress;

  function buildDraft(): PerpsOrderDraft | null {
    if (!walletAddress) return null;

    const inputTokenAmount = uiAmountToAtomicString(amount, inputToken);
    if (!inputTokenAmount) return null;

    return {
      asset,
      inputToken,
      inputTokenAmount,
      leverage,
      maxSlippageBps,
      orderType,
      side,
      walletAddress,
      triggerPrice: orderType === "limit" ? triggerPrice : null,
      takeProfitPrice: enableTpSl && takeProfitPrice.trim() ? takeProfitPrice.trim() : null,
      stopLossPrice: enableTpSl && stopLossPrice.trim() ? stopLossPrice.trim() : null,
    };
  }

  async function handlePreview() {
    const draft = buildDraft();
    if (!draft) {
      setStatus("Enter a valid collateral amount before previewing the Perps order.");
      return;
    }

    setStatus("Fetching Jupiter Perps preview...");
    const nextPreview = await buildPreview(draft);
    setPreview(nextPreview);
    setStatus("Preview ready.");
  }

  async function handleSubmit() {
    const draft = buildDraft();
    if (!draft) {
      setStatus("Enter a valid collateral amount before submitting the Perps order.");
      return;
    }

    if (!canSign) {
      setStatus("Connect Jupiter Mobile in the native app before opening a new Perps order.");
      return;
    }

    setStatus(orderType === "limit" ? "Submitting Jupiter Perps trigger order..." : "Submitting Jupiter Perps market order...");
    const result = await openPosition(draft);
    setPreview(result.preview);
    setStatus(`Perps order submitted. Tx ${result.txid.slice(0, 10)}...`);
    await onPlaced();
  }

  return (
    <div className="perps-composer-shell">
      <div className="perps-composer-header">
        <div>
          <strong>New Perp</strong>
          <div className="subtext">Contained Jupiter Perps order ticket powered by the public Perps trading API.</div>
        </div>
        <button type="button" className="secondary" onClick={onBack}>
          Back
        </button>
      </div>

      <div className="perps-toggle-row">
        <button type="button" className={side === "long" ? "" : "secondary"} onClick={() => setSide("long")}>
          Long / Buy
        </button>
        <button type="button" className={side === "short" ? "" : "secondary"} onClick={() => setSide("short")}>
          Short / Sell
        </button>
      </div>

      <div className="perps-toggle-row">
        <button type="button" className={orderType === "market" ? "" : "secondary"} onClick={() => setOrderType("market")}>
          Market
        </button>
        <button type="button" className={orderType === "limit" ? "" : "secondary"} onClick={() => setOrderType("limit")}>
          Limit
        </button>
      </div>

      <div className="perps-composer-grid">
        <label className="perps-field">
          <span>Market</span>
          <select value={asset} onChange={(event) => setAsset(event.target.value as PerpsAsset)}>
            {PERPS_ASSET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="perps-field">
          <span>Collateral</span>
          <select value={inputToken} onChange={(event) => setInputToken(event.target.value as PerpsInputToken)}>
            {PERPS_INPUT_TOKEN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="perps-field">
          <span>You&apos;re paying</span>
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="10" />
        </label>

        <label className="perps-field">
          <span>Leverage</span>
          <input inputMode="decimal" value={leverage} onChange={(event) => setLeverage(event.target.value)} placeholder="10" />
        </label>

        {orderType === "limit" ? (
          <label className="perps-field perps-field-span-2">
            <span>Trigger price</span>
            <input inputMode="decimal" value={triggerPrice} onChange={(event) => setTriggerPrice(event.target.value)} placeholder="83.26" />
          </label>
        ) : null}

        <label className="perps-field perps-field-span-2">
          <span>Max slippage (bps)</span>
          <input inputMode="numeric" value={maxSlippageBps} onChange={(event) => setMaxSlippageBps(event.target.value)} placeholder="100" />
        </label>
      </div>

      {orderType === "market" ? (
        <label className="perps-checkbox-row">
          <input checked={enableTpSl} type="checkbox" onChange={(event) => setEnableTpSl(event.target.checked)} />
          <span>Take Profit / Stop Loss</span>
        </label>
      ) : (
        <div className="subtext">TP / SL requests can be added after the trigger order fills.</div>
      )}

      {orderType === "market" && enableTpSl ? (
        <div className="perps-composer-grid">
          <label className="perps-field">
            <span>Take profit</span>
            <input inputMode="decimal" value={takeProfitPrice} onChange={(event) => setTakeProfitPrice(event.target.value)} placeholder="84.00" />
          </label>
          <label className="perps-field">
            <span>Stop loss</span>
            <input inputMode="decimal" value={stopLossPrice} onChange={(event) => setStopLossPrice(event.target.value)} placeholder="81.00" />
          </label>
        </div>
      ) : null}

      <div className="wallet-controls">
        <button type="button" className="secondary" onClick={() => void handlePreview()} disabled={isPreviewing || isSubmitting}>
          {isPreviewing ? "Previewing..." : "Preview"}
        </button>
        <button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
          {isSubmitting ? "Submitting..." : orderType === "limit" ? (side === "long" ? "Place Long Trigger" : "Place Short Trigger") : (side === "long" ? "Long / Buy" : "Short / Sell")}
        </button>
      </div>

      {status ? <div className="perps-inline-banner">{status}</div> : null}
      {error ? <div className="perps-inline-banner" role="alert">{error}</div> : null}

      {preview ? (
        <div className="perps-preview-card">
          <div className="perps-preview-head">
            <strong>{asset} {orderType === "limit" ? "Trigger" : "Market"} Preview</strong>
            <span className={`perps-side-badge ${side === "long" ? "long" : "short"}`}>{side === "long" ? "Long" : "Short"}</span>
          </div>
          <div className="perps-metric-grid">
            <PositionMetric label="Mark" value={preview.market.price === null ? "-" : formatUsd(preview.market.price)} />
            <PositionMetric label="Entry" value={preview.quote.averagePriceUsd === null ? "-" : formatUsd(preview.quote.averagePriceUsd)} />
            <PositionMetric label="Position Size" value={preview.quote.positionSizeUsd === null ? "-" : formatUsd(preview.quote.positionSizeUsd)} />
            <PositionMetric label="Collateral" value={preview.quote.positionCollateralUsd === null ? "-" : formatUsd(preview.quote.positionCollateralUsd)} />
            <PositionMetric label="Liquidation" value={preview.quote.liquidationPriceUsd === null ? "-" : formatUsd(preview.quote.liquidationPriceUsd)} />
            <PositionMetric label="Open Fee" value={preview.quote.openFeeUsd === null ? "-" : formatUsd(preview.quote.openFeeUsd)} />
            <PositionMetric label="Borrow" value={preview.quote.outstandingBorrowFeeUsd === null ? "-" : formatUsd(preview.quote.outstandingBorrowFeeUsd)} />
            <PositionMetric label="Impact Fee" value={preview.quote.priceImpactFeeUsd === null ? "-" : formatUsd(preview.quote.priceImpactFeeUsd)} />
            <PositionMetric label="Impact %" value={formatPercentNumber(preview.pool.maxPriceImpactFeePercent, 2)} />
            <PositionMetric label="Borrow Rate" value={formatPercentNumber(side === "long" ? preview.pool.longBorrowRatePercent : preview.pool.shortBorrowRatePercent, 2)} />
          </div>
        </div>
      ) : null}

      {!canSign ? (
        <div className="perps-empty-state">
          <strong>Connect Jupiter Mobile to submit</strong>
          <span className="subtext">Previews can be built from the public API once the wallet is connected, and signing stays inside Jupiter Mobile.</span>
        </div>
      ) : null}
    </div>
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

function EditableTpslMetric({
  disabled,
  isSaving,
  kind,
  onSubmit,
  position,
  requestPubkey,
  value,
}: {
  disabled: boolean;
  isSaving: boolean;
  kind: "tp" | "sl";
  onSubmit: (nextValue: string, requestPubkey: string | null) => Promise<void>;
  position: JupiterPerpsPosition;
  requestPubkey: string | null;
  value: number | null;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(formatEditableUsdPrice(value));
  const [status, setStatus] = useState<string | null>(null);
  const parsedDraftValue = Number(draftValue.trim());
  const estimatedPnl = Number.isFinite(parsedDraftValue) && parsedDraftValue > 0
    ? estimateTriggerPnl(position, parsedDraftValue)
    : null;
  const estimatedPnlIsTooSmall = estimatedPnl !== null && Math.abs(estimatedPnl) < MIN_TPSL_EXPECTED_PNL_USD;

  useEffect(() => {
    if (!isEditing) {
      setDraftValue(formatEditableUsdPrice(value));
    }
  }, [isEditing, value]);

  async function handleSave() {
    const trimmed = draftValue.trim();
    const parsed = Number(trimmed);
    const validationMessage = validatePerpsTriggerPrice(kind, position, parsed);
    if (!trimmed || validationMessage) {
      setStatus(validationMessage ?? "Enter a valid trigger price above 0.");
      return;
    }

    const nextEstimatedPnl = estimateTriggerPnl(position, parsed);
    if (nextEstimatedPnl !== null && Math.abs(nextEstimatedPnl) < MIN_TPSL_EXPECTED_PNL_USD) {
      setStatus(`Expected PnL is ${formatSignedUsd(nextEstimatedPnl)}. Move the trigger farther from entry so expected PnL is at least ${formatUsd(MIN_TPSL_EXPECTED_PNL_USD)}.`);
      return;
    }

    setStatus(null);

    try {
      await onSubmit(parsed.toFixed(2), requestPubkey);
      setIsEditing(false);
      setStatus(`${kind === "tp" ? "Take profit" : "Stop loss"} updated.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to update the TP/SL request.");
    }
  }

  return (
    <div className="perps-metric perps-metric-editable">
      <span>{kind === "tp" ? "Pending TP" : "Pending SL"}</span>
      {!isEditing ? (
        <>
          <strong>{value === null ? "-" : formatUsd(value)}</strong>
          <div className="wallet-controls perps-metric-actions">
            <button type="button" className="secondary" disabled={disabled || isSaving} onClick={() => setIsEditing(true)}>
              Modify
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="perps-inline-input-shell">
            <span className="perps-inline-input-prefix">$</span>
            <input
              className="perps-inline-input"
              inputMode="decimal"
              value={draftValue}
              onChange={(event) => setDraftValue(event.target.value.replace(/[^0-9.]/g, ""))}
              placeholder={kind === "tp" ? "84.00" : "81.00"}
            />
          </label>
          <span className={`perps-metric-status ${estimatedPnl !== null ? (estimatedPnl >= 0 ? "pnl-positive" : "pnl-negative") : ""}`}>
            Expected PnL: {formatSignedUsd(estimatedPnl)}
          </span>
          {estimatedPnlIsTooSmall ? (
            <span className="perps-metric-status">Minimum expected PnL: {formatUsd(MIN_TPSL_EXPECTED_PNL_USD)}</span>
          ) : null}
          <div className="wallet-controls perps-metric-actions">
            <button type="button" disabled={disabled || isSaving || estimatedPnlIsTooSmall} onClick={() => void handleSave()}>
              {isSaving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={isSaving}
              onClick={() => {
                setDraftValue(formatEditableUsdPrice(value));
                setStatus(null);
                setIsEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
      {status ? <span className="perps-metric-status">{status}</span> : null}
    </div>
  );
}

function PositionCard({
  closingPositionPubkey,
  isMutatingTpsl,
  onModifyTpsl,
  pendingTriggers,
  onClosePosition,
  pendingClosePositionPubkeys,
  position,
  writeEnabled,
}: {
  closingPositionPubkey: string | null;
  isMutatingTpsl: boolean;
  onModifyTpsl: (request: {
    kind: "tp" | "sl";
    position: JupiterPerpsPosition;
    positionRequestPubkey: string | null;
    triggerPrice: string;
  }) => Promise<void>;
  pendingTriggers: JupiterPerpsPendingTrigger[];
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
  const takeProfitTrigger = pendingTriggers.find((trigger) => trigger.kind === "take-profit");
  const stopLossTrigger = pendingTriggers.find((trigger) => trigger.kind === "stop-loss");

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
        <EditableTpslMetric
          disabled={!canClose}
          isSaving={isMutatingTpsl}
          kind="tp"
          onSubmit={(triggerPrice, positionRequestPubkey) => onModifyTpsl({
            kind: "tp",
            position,
            positionRequestPubkey,
            triggerPrice,
          })}
          position={position}
          requestPubkey={takeProfitTrigger?.positionRequestPubkey ?? null}
          value={takeProfitTrigger?.triggerPrice ?? position.takeProfit}
        />
        <EditableTpslMetric
          disabled={!canClose}
          isSaving={isMutatingTpsl}
          kind="sl"
          onSubmit={(triggerPrice, positionRequestPubkey) => onModifyTpsl({
            kind: "sl",
            position,
            positionRequestPubkey,
            triggerPrice,
          })}
          position={position}
          requestPubkey={stopLossTrigger?.positionRequestPubkey ?? null}
          value={stopLossTrigger?.triggerPrice ?? position.stopLoss}
        />
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
  onControllerChange,
}: {
  onSnapshotChange?: (snapshot: JupiterPerpsWidgetSnapshot) => void;
  onControllerChange?: (controller: JupiterPerpsWidgetController | null) => void;
}) {
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const [isWidgetVisible, setIsWidgetVisible] = useState(true);
  const [activeTab, setActiveTab] = useState<"open" | "recent" | "new">("open");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [showMockData, setShowMockData] = useState(process.env.NEXT_PUBLIC_JUPITER_PERPS_DEMO === "true");
  const [pendingClosePositionPubkeys, setPendingClosePositionPubkeys] = useState<string[]>([]);
  const [pendingTpslMutationKey, setPendingTpslMutationKey] = useState<string | null>(null);
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
  const {
    attachTpsl,
    buildPreview,
    cancelTpsl,
    clearError: clearOpenError,
    error: openError,
    isPreviewing,
    isSubmitting,
    openPosition,
    updateTpsl,
  } = useJupiterPerpsOpenPosition({
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

  const autoTradeController = useMemo<JupiterPerpsWidgetController | null>(() => {
    if (!nativeJupiterAdapterEnabled) return null;

    return {
      attachTpsl: async ({
        positionPubkey,
        stopLossPrice,
        takeProfitPrice,
      }) => {
        if (!walletAddress) {
          throw new Error("Connect Jupiter Mobile before attaching Perps TP/SL.");
        }

        const tpsl = [
          ...(typeof takeProfitPrice === "number" && Number.isFinite(takeProfitPrice)
            ? [{ receiveToken: "USDC" as const, requestType: "tp" as const, triggerPrice: takeProfitPrice.toFixed(6) }]
            : []),
          ...(typeof stopLossPrice === "number" && Number.isFinite(stopLossPrice)
            ? [{ receiveToken: "USDC" as const, requestType: "sl" as const, triggerPrice: stopLossPrice.toFixed(6) }]
            : []),
        ];

        if (tpsl.length === 0) {
          throw new Error("No TP/SL values were provided to attach.");
        }

        const result = await attachTpsl({
          positionPubkey,
          tpsl,
          walletAddress,
        });

        await refetch();
        return result;
      },
      canWrite: writeEnabled,
      connected: isConnected,
      refresh: refetch,
      walletAddress,
      previewMarketPosition: async ({
        asset,
        collateralToken,
        leverage,
        maxSlippageBps = "100",
        side,
        stopLossPrice,
        takeProfitPrice,
        uiAmount,
      }) => {
        if (!walletAddress) {
          throw new Error("Connect Jupiter Mobile before previewing a Perps order.");
        }

        const inputTokenAmount = uiNumberAmountToAtomicString(uiAmount, collateralToken);
        if (!inputTokenAmount) {
          throw new Error("Enter a valid Perps collateral amount greater than zero.");
        }

        return buildPreview({
          asset,
          inputToken: collateralToken,
          inputTokenAmount,
          leverage,
          maxSlippageBps,
          orderType: "market",
          side,
          walletAddress,
          stopLossPrice: typeof stopLossPrice === "number" && Number.isFinite(stopLossPrice) ? stopLossPrice.toFixed(6) : null,
          takeProfitPrice: typeof takeProfitPrice === "number" && Number.isFinite(takeProfitPrice) ? takeProfitPrice.toFixed(6) : null,
          triggerPrice: null,
        });
      },
      openMarketPosition: async ({
        asset,
        collateralToken,
        leverage,
        maxSlippageBps = "100",
        side,
        stopLossPrice,
        takeProfitPrice,
        uiAmount,
      }) => {
        if (!walletAddress) {
          throw new Error("Connect Jupiter Mobile before opening a Perps order.");
        }

        const inputTokenAmount = uiNumberAmountToAtomicString(uiAmount, collateralToken);
        if (!inputTokenAmount) {
          throw new Error("Enter a valid Perps collateral amount greater than zero.");
        }

        const result = await openPosition({
          asset,
          inputToken: collateralToken,
          inputTokenAmount,
          leverage,
          maxSlippageBps,
          orderType: "market",
          side,
          walletAddress,
          stopLossPrice: typeof stopLossPrice === "number" && Number.isFinite(stopLossPrice) ? stopLossPrice.toFixed(6) : null,
          takeProfitPrice: typeof takeProfitPrice === "number" && Number.isFinite(takeProfitPrice) ? takeProfitPrice.toFixed(6) : null,
          triggerPrice: null,
        });

        await refetch();
        return {
          positionPubkey: result.preview.positionPubkey,
          txid: result.txid,
        };
      },
    };
  }, [attachTpsl, buildPreview, isConnected, nativeJupiterAdapterEnabled, openPosition, refetch, walletAddress, writeEnabled]);

  useEffect(() => {
    onControllerChange?.(autoTradeController);
  }, [autoTradeController, onControllerChange]);

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

  async function handleNewPerpPlaced() {
    clearOpenError();
    setActiveTab("open");
    await refetch();
  }

  async function handleModifyTpsl(request: {
    kind: "tp" | "sl";
    position: JupiterPerpsPosition;
    positionRequestPubkey: string | null;
    triggerPrice: string;
  }) {
    const positionPubkey = request.position.accountRef?.trim();
    if (!positionPubkey || !walletAddress) {
      throw new Error("Connect Jupiter Mobile before editing this TP/SL request.");
    }

    const confirmedPositionPubkey = positionPubkey;
    const confirmedWalletAddress = walletAddress;

    clearOpenError();
    setPendingTpslMutationKey(`${confirmedPositionPubkey}:${request.kind}`);

    const matchedTriggers = pendingTriggers.filter((trigger) => doesTriggerBelongToPosition(request.position, trigger));
    const takeProfitTrigger = matchedTriggers.find((trigger) => trigger.kind === "take-profit");
    const stopLossTrigger = matchedTriggers.find((trigger) => trigger.kind === "stop-loss");
    const desiredTakeProfitPrice =
      request.kind === "tp"
        ? request.triggerPrice
        : (takeProfitTrigger?.triggerPrice ?? request.position.takeProfit)?.toFixed(2) ?? null;
    const desiredStopLossPrice =
      request.kind === "sl"
        ? request.triggerPrice
        : (stopLossTrigger?.triggerPrice ?? request.position.stopLoss)?.toFixed(2) ?? null;
    const desiredTpsl = [
      ...(desiredTakeProfitPrice
        ? [{
            entirePosition: true,
            receiveToken: getPerpsTpslReceiveToken(request.position),
            requestType: "tp" as const,
            triggerPrice: desiredTakeProfitPrice,
          }]
        : []),
      ...(desiredStopLossPrice
        ? [{
            entirePosition: true,
            receiveToken: getPerpsTpslReceiveToken(request.position),
            requestType: "sl" as const,
            triggerPrice: desiredStopLossPrice,
          }]
        : []),
    ];
    const existingRequestPubkeys = [...new Set(
      matchedTriggers
        .map((trigger) => trigger.positionRequestPubkey?.trim() ?? "")
        .filter((pubkey) => pubkey.length > 0)
    )];
    let usedRebuildPath = false;

    async function rebuildTpsl() {
      usedRebuildPath = true;

      for (const existingRequestPubkey of existingRequestPubkeys) {
        await cancelTpsl({ positionRequestPubkey: existingRequestPubkey });
      }

      await attachTpsl({
        positionPubkey: confirmedPositionPubkey,
        tpsl: desiredTpsl,
        walletAddress: confirmedWalletAddress,
      });
    }

    try {
      if (request.positionRequestPubkey) {
        await updateTpsl({
          positionRequestPubkey: request.positionRequestPubkey,
          triggerPrice: request.triggerPrice,
        });
      } else if (existingRequestPubkeys.length === 0) {
        await attachTpsl({
          positionPubkey: confirmedPositionPubkey,
          tpsl: [{
            entirePosition: true,
            receiveToken: getPerpsTpslReceiveToken(request.position),
            requestType: request.kind,
            triggerPrice: request.triggerPrice,
          }],
          walletAddress: confirmedWalletAddress,
        });
      } else {
        await rebuildTpsl();
      }
    } catch (error) {
      if (usedRebuildPath || existingRequestPubkeys.length === 0 || desiredTpsl.length === 0) {
        throw error;
      }

      await rebuildTpsl();
    } finally {
      await refetch();
      setPendingTpslMutationKey(null);
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
    <div ref={widgetRef} className="perps-widget-shell">
      <div className="perps-widget-header">
        <div>
          <div className="perps-widget-title-row">
            <strong>Jupiter Perps</strong>
            {isMock ? <span className="perps-demo-badge">Demo</span> : null}
            <button type="button" className="secondary perps-new-button" onClick={() => setActiveTab("new")}>
              New Perp
            </button>
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
          {shouldRecommendJupiterMobile && !nativeShell ? (
            <div className="perps-wallet-note">
              Open BremLogic inside Jupiter Mobile&apos;s dApp browser if you want to use Jupiter wallet on mobile web.
            </div>
          ) : null}
          {nativeShell && nativeJupiterAdapterEnabled ? (
            <div className="perps-wallet-grid">
              <div className="perps-message-card">
                <strong>Connect with Jupiter Mobile</strong>
                <div className="wallet-controls" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="perps-wallet-option perps-wallet-option-native"
                    onClick={() => void handleNativeJupiterConnect()}
                  >
                    <span>Open Jupiter Mobile</span>
                  </button>
                </div>
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

      {openError && !isSubmitting ? (
        <div className="perps-inline-banner" role="alert">
          {openError}
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

        {!isLoading && activeTab === "new" ? (
          <div className="perps-list">
            <NewPerpComposer
              buildPreview={buildPreview}
              connected={isConnected}
              error={openError}
              isPreviewing={isPreviewing}
              isSubmitting={isSubmitting}
              onBack={() => setActiveTab(positions.length > 0 ? "open" : "recent")}
              onPlaced={handleNewPerpPlaced}
              openPosition={openPosition}
              walletAddress={walletAddress}
              writeEnabled={writeEnabled}
            />
          </div>
        ) : null}

        {!isLoading && activeTab === "open" && shouldShowDisconnectedState ? (
          <div className="perps-empty-state">
            <strong>Connect a Solana wallet</strong>
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
            {positions.map((position) => {
              const positionPendingTriggers = pendingTriggers.filter((trigger) => (
                doesTriggerBelongToPosition(position, trigger)
              ));

              return (
              <PositionCard
                key={position.id}
                closingPositionPubkey={closingPositionPubkey}
                isMutatingTpsl={pendingTpslMutationKey === `${position.accountRef?.trim() ?? ""}:tp` || pendingTpslMutationKey === `${position.accountRef?.trim() ?? ""}:sl`}
                onModifyTpsl={handleModifyTpsl}
                pendingTriggers={positionPendingTriggers}
                onClosePosition={handleClosePosition}
                pendingClosePositionPubkeys={pendingClosePositionPubkeySet}
                position={position}
                writeEnabled={writeEnabled}
              />
              );
            })}
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
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function JupiterPerpsPositionWidget({
  onSnapshotChange,
  onControllerChange,
}: {
  onSnapshotChange?: (snapshot: JupiterPerpsWidgetSnapshot) => void;
  onControllerChange?: (controller: JupiterPerpsWidgetController | null) => void;
}) {
  return <JupiterPerpsPositionWidgetBody onSnapshotChange={onSnapshotChange} onControllerChange={onControllerChange} />;
}
