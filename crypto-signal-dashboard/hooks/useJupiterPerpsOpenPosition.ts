"use client";

import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";

type PerpsAsset = "BTC" | "ETH" | "SOL";
type PerpsInputToken = PerpsAsset | "USDC";
type PerpsSide = "long" | "short";
type PerpsOrderType = "market" | "limit";

export type PerpsOrderDraft = {
  asset: PerpsAsset;
  inputToken: PerpsInputToken;
  inputTokenAmount: string;
  leverage: string;
  maxSlippageBps: string;
  orderType: PerpsOrderType;
  side: PerpsSide;
  stopLossPrice?: string | null;
  takeProfitPrice?: string | null;
  triggerPrice?: string | null;
  walletAddress: string;
};

export type PerpsOrderPreview = {
  asset: PerpsAsset;
  inputToken: PerpsInputToken;
  market: {
    change24h: number | null;
    high24h: number | null;
    low24h: number | null;
    price: number | null;
    volume24h: number | null;
  };
  orderType: PerpsOrderType;
  pool: {
    longBorrowRatePercent: number | null;
    maxPriceImpactFeePercent: number | null;
    openFeePercent: number | null;
    shortBorrowRatePercent: number | null;
  };
  positionPubkey: string | null;
  quote: {
    averagePriceUsd: number | null;
    collateralUsdDelta: number | null;
    leverage: number | null;
    liquidationPriceUsd: number | null;
    openFeeUsd: number | null;
    outstandingBorrowFeeUsd: number | null;
    positionCollateralUsd: number | null;
    positionSizeUsd: number | null;
    priceImpactFeeBps: number | null;
    priceImpactFeeUsd: number | null;
    sizeUsdDelta: number | null;
  };
  serializedTxBase64: string | null;
  side: PerpsSide;
};

type OpenPerpsResult = {
  preview: PerpsOrderPreview;
  txid: string;
};

export type PerpsTpslDraft = {
  positionPubkey: string;
  tpsl: Array<{
    entirePosition?: boolean;
    receiveToken: PerpsInputToken;
    sizeUsdDelta?: string | null;
    triggerPrice: string;
    requestType: "tp" | "sl";
  }>;
  walletAddress: string;
};

export type PerpsTpslUpdateDraft = {
  positionRequestPubkey: string;
  triggerPrice: string;
};

type AttachTpslResult = {
  requestPubkeys: string[];
  txid: string;
};

type UseJupiterPerpsOpenPositionOptions = {
  signTransaction?: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
};

type UseJupiterPerpsOpenPositionResult = {
  attachTpsl: (draft: PerpsTpslDraft) => Promise<AttachTpslResult>;
  cancelTpsl: (draft: { positionRequestPubkey: string }) => Promise<{ txid: string }>;
  updateTpsl: (draft: PerpsTpslUpdateDraft) => Promise<{ txid: string }>;
  buildPreview: (draft: PerpsOrderDraft) => Promise<PerpsOrderPreview>;
  error: string | null;
  isPreviewing: boolean;
  isSubmitting: boolean;
  openPosition: (draft: PerpsOrderDraft) => Promise<OpenPerpsResult>;
  clearError: () => void;
};

type OpenPerpsResponse = PerpsOrderPreview & {
  error?: string;
  detail?: string;
};

type ExecuteSignedTransactionResponse = {
  error?: string;
  detail?: string;
  txid?: string;
};

type CreateTpslResponse = {
  error?: string;
  detail?: string;
  serializedTxBase64?: string;
  tpslPubkeys?: string[];
};

type UpdateTpslResponse = {
  error?: string;
  detail?: string;
  serializedTxBase64?: string;
};

type CancelTpslResponse = {
  error?: string;
  detail?: string;
  serializedTxBase64?: string;
};

const PERPS_ERROR_AUTO_CLEAR_MS = 20_000;

function fromBase64(input: string) {
  const raw = atob(input);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function formatPerpsErrorMessage(error?: string, detail?: string) {
  const trimmedError = error?.trim() ?? "";
  const trimmedDetail = detail?.trim() ?? "";

  if (trimmedDetail && trimmedDetail !== trimmedError) {
    return trimmedError ? `${trimmedError} Detail: ${trimmedDetail}` : trimmedDetail;
  }

  return trimmedError || trimmedDetail || "Unable to build the Jupiter Perps order.";
}

export function useJupiterPerpsOpenPosition({
  signTransaction,
}: UseJupiterPerpsOpenPositionOptions): UseJupiterPerpsOpenPositionResult {
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearErrorTimeout = useCallback(() => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
  }, []);

  const setTimedError = useCallback((message: string) => {
    clearErrorTimeout();
    setError(message);
    errorTimeoutRef.current = setTimeout(() => {
      setError(null);
      errorTimeoutRef.current = null;
    }, PERPS_ERROR_AUTO_CLEAR_MS);
  }, [clearErrorTimeout]);

  const clearError = useCallback(() => {
    clearErrorTimeout();
    setError(null);
  }, [clearErrorTimeout]);

  useEffect(() => {
    return () => {
      clearErrorTimeout();
    };
  }, [clearErrorTimeout]);

  const requestOrder = useCallback(async (draft: PerpsOrderDraft) => {
    const response = await fetch("/api/jupiter/perps/open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(draft),
    });

    const payload = await response.json().catch(() => null) as OpenPerpsResponse | null;
    if (!response.ok || !payload) {
      throw new Error(formatPerpsErrorMessage(payload?.error, payload?.detail));
    }

    return payload;
  }, []);

  const buildPreview = useCallback(async (draft: PerpsOrderDraft) => {
    setIsPreviewing(true);
    setError(null);

    try {
      return await requestOrder(draft);
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "Unable to preview the Jupiter Perps order.";
      setTimedError(message);
      throw previewError;
    } finally {
      setIsPreviewing(false);
    }
  }, [requestOrder, setTimedError]);

  const attachTpsl = useCallback(async (draft: PerpsTpslDraft) => {
    if (!signTransaction) {
      throw new Error("A connected Jupiter wallet is required to sign the Perps TP/SL request.");
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/jupiter/perps/tpsl", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });

      const payload = await response.json().catch(() => null) as CreateTpslResponse | null;
      if (!response.ok || !payload) {
        throw new Error(formatPerpsErrorMessage(payload?.error || "Unable to create Jupiter Perps TP/SL request.", payload?.detail));
      }

      const serializedTxBase64 = payload.serializedTxBase64?.trim();
      if (!serializedTxBase64) {
        throw new Error("Jupiter did not return a TP/SL transaction to sign.");
      }

      const transaction = VersionedTransaction.deserialize(fromBase64(serializedTxBase64));
      const signedTransaction = await signTransaction(transaction);
      const signedSerializedTxBase64 = toBase64(signedTransaction.serialize());

      const executeResponse = await fetch("/api/jupiter/perps/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "create-tpsl",
          serializedTxBase64: signedSerializedTxBase64,
        }),
      });

      const executePayload = await executeResponse.json().catch(() => null) as ExecuteSignedTransactionResponse | null;
      if (!executeResponse.ok) {
        throw new Error(
          formatPerpsErrorMessage(
            executePayload?.error || "Jupiter could not execute the signed TP/SL transaction.",
            executePayload?.detail
          )
        );
      }

      const txid = executePayload?.txid?.trim();
      if (!txid) {
        throw new Error("Jupiter did not return a TP/SL transaction signature.");
      }

      return {
        requestPubkeys: payload.tpslPubkeys ?? [],
        txid,
      };
    } catch (attachError) {
      const message = attachError instanceof Error ? attachError.message : "Unable to attach Jupiter Perps TP/SL.";
      setTimedError(message);
      throw attachError;
    } finally {
      setIsSubmitting(false);
    }
  }, [setTimedError, signTransaction]);

  const updateTpsl = useCallback(async (draft: PerpsTpslUpdateDraft) => {
    if (!signTransaction) {
      throw new Error("A connected Jupiter wallet is required to sign the Perps TP/SL update.");
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/jupiter/perps/tpsl", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });

      const payload = await response.json().catch(() => null) as UpdateTpslResponse | null;
      if (!response.ok || !payload) {
        throw new Error(formatPerpsErrorMessage(payload?.error || "Unable to update Jupiter Perps TP/SL request.", payload?.detail));
      }

      const serializedTxBase64 = payload.serializedTxBase64?.trim();
      if (!serializedTxBase64) {
        throw new Error("Jupiter did not return a TP/SL update transaction to sign.");
      }

      const transaction = VersionedTransaction.deserialize(fromBase64(serializedTxBase64));
      const signedTransaction = await signTransaction(transaction);
      const signedSerializedTxBase64 = toBase64(signedTransaction.serialize());

      const executeResponse = await fetch("/api/jupiter/perps/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "update-tpsl",
          serializedTxBase64: signedSerializedTxBase64,
        }),
      });

      const executePayload = await executeResponse.json().catch(() => null) as ExecuteSignedTransactionResponse | null;
      if (!executeResponse.ok) {
        throw new Error(
          formatPerpsErrorMessage(
            executePayload?.error || "Jupiter could not execute the signed TP/SL update transaction.",
            executePayload?.detail
          )
        );
      }

      const txid = executePayload?.txid?.trim();
      if (!txid) {
        throw new Error("Jupiter did not return a TP/SL update transaction signature.");
      }

      return { txid };
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : "Unable to update Jupiter Perps TP/SL.";
      setTimedError(message);
      throw updateError;
    } finally {
      setIsSubmitting(false);
    }
  }, [setTimedError, signTransaction]);

  const cancelTpsl = useCallback(async ({ positionRequestPubkey }: { positionRequestPubkey: string }) => {
    if (!signTransaction) {
      throw new Error("A connected Jupiter wallet is required to sign the Perps TP/SL cancellation.");
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/jupiter/perps/tpsl", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ positionRequestPubkey }),
      });

      const payload = await response.json().catch(() => null) as CancelTpslResponse | null;
      if (!response.ok || !payload) {
        throw new Error(formatPerpsErrorMessage(payload?.error || "Unable to cancel Jupiter Perps TP/SL request.", payload?.detail));
      }

      const serializedTxBase64 = payload.serializedTxBase64?.trim();
      if (!serializedTxBase64) {
        throw new Error("Jupiter did not return a TP/SL cancel transaction to sign.");
      }

      const transaction = VersionedTransaction.deserialize(fromBase64(serializedTxBase64));
      const signedTransaction = await signTransaction(transaction);
      const signedSerializedTxBase64 = toBase64(signedTransaction.serialize());

      const executeResponse = await fetch("/api/jupiter/perps/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "cancel-tpsl",
          serializedTxBase64: signedSerializedTxBase64,
        }),
      });

      const executePayload = await executeResponse.json().catch(() => null) as ExecuteSignedTransactionResponse | null;
      if (!executeResponse.ok) {
        throw new Error(
          formatPerpsErrorMessage(
            executePayload?.error || "Jupiter could not execute the signed TP/SL cancellation.",
            executePayload?.detail
          )
        );
      }

      const txid = executePayload?.txid?.trim();
      if (!txid) {
        throw new Error("Jupiter did not return a TP/SL cancel transaction signature.");
      }

      return { txid };
    } catch (cancelError) {
      const message = cancelError instanceof Error ? cancelError.message : "Unable to cancel Jupiter Perps TP/SL.";
      setTimedError(message);
      throw cancelError;
    } finally {
      setIsSubmitting(false);
    }
  }, [setTimedError, signTransaction]);

  const openPosition = useCallback(async (draft: PerpsOrderDraft) => {
    if (!signTransaction) {
      throw new Error("A connected Jupiter wallet is required to sign the Perps order.");
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const preview = await requestOrder(draft);
      const serializedTxBase64 = preview.serializedTxBase64?.trim();

      if (!serializedTxBase64) {
        throw new Error("Jupiter did not return a Perps transaction to sign.");
      }

      const transaction = VersionedTransaction.deserialize(fromBase64(serializedTxBase64));
      const signedTransaction = await signTransaction(transaction);
      const signedSerializedTxBase64 = toBase64(signedTransaction.serialize());

      const action = draft.orderType === "limit" ? "create-limit-order" : "increase-position";
      const executeResponse = await fetch("/api/jupiter/perps/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          serializedTxBase64: signedSerializedTxBase64,
        }),
      });

      const executePayload = await executeResponse.json().catch(() => null) as ExecuteSignedTransactionResponse | null;
      if (!executeResponse.ok) {
        throw new Error(
          formatPerpsErrorMessage(
            executePayload?.error || "Jupiter could not execute the signed Perps transaction.",
            executePayload?.detail
          )
        );
      }

      const txid = executePayload?.txid?.trim();
      if (!txid) {
        throw new Error("Jupiter did not return a Perps transaction signature.");
      }

      return { preview, txid };
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit the Jupiter Perps order.";
      setTimedError(message);
      throw submitError;
    } finally {
      setIsSubmitting(false);
    }
  }, [requestOrder, setTimedError, signTransaction]);

  return {
    attachTpsl,
    cancelTpsl,
    updateTpsl,
    buildPreview,
    error,
    isPreviewing,
    isSubmitting,
    openPosition,
    clearError,
  };
}
