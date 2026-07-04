"use client";

import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useState } from "react";

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
    change24h: number;
    high24h: number;
    low24h: number;
    price: number;
    volume24h: number;
  };
  orderType: PerpsOrderType;
  pool: {
    longBorrowRatePercent: number;
    maxPriceImpactFeePercent: number;
    openFeePercent: number;
    shortBorrowRatePercent: number;
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

type UseJupiterPerpsOpenPositionOptions = {
  signTransaction?: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
};

type UseJupiterPerpsOpenPositionResult = {
  buildPreview: (draft: PerpsOrderDraft) => Promise<PerpsOrderPreview>;
  error: string | null;
  isPreviewing: boolean;
  isSubmitting: boolean;
  openPosition: (draft: PerpsOrderDraft) => Promise<OpenPerpsResult>;
  clearError: () => void;
};

type OpenPerpsResponse = PerpsOrderPreview & {
  error?: string;
};

type ExecuteSignedTransactionResponse = {
  error?: string;
  txid?: string;
};

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

export function useJupiterPerpsOpenPosition({
  signTransaction,
}: UseJupiterPerpsOpenPositionOptions): UseJupiterPerpsOpenPositionResult {
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

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
      throw new Error(payload?.error || "Unable to build the Jupiter Perps order.");
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
      setError(message);
      throw previewError;
    } finally {
      setIsPreviewing(false);
    }
  }, [requestOrder]);

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
        throw new Error(executePayload?.error || "Jupiter could not execute the signed Perps transaction.");
      }

      const txid = executePayload?.txid?.trim();
      if (!txid) {
        throw new Error("Jupiter did not return a Perps transaction signature.");
      }

      return { preview, txid };
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unable to submit the Jupiter Perps order.";
      setError(message);
      throw submitError;
    } finally {
      setIsSubmitting(false);
    }
  }, [requestOrder, signTransaction]);

  return {
    buildPreview,
    error,
    isPreviewing,
    isSubmitting,
    openPosition,
    clearError,
  };
}
