"use client";

import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useState } from "react";

type ClosePositionParams = {
  maxSlippageBps?: string;
  positionPubkey: string;
  receiveToken: "BTC" | "ETH" | "SOL" | "USDC";
};

type ClosePositionResult = {
  txid: string;
};

type UseJupiterPerpsClosePositionOptions = {
  signTransaction?: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
};

type UseJupiterPerpsClosePositionResult = {
  closePosition: (params: ClosePositionParams) => Promise<ClosePositionResult>;
  closingPositionPubkey: string | null;
  error: string | null;
  clearError: () => void;
};

type CreateCloseTransactionResponse = {
  serializedTxBase64?: string;
  error?: string;
};

type ExecuteSignedTransactionResponse = {
  txid?: string;
  error?: string;
};

function fromBase64(input: string) {
  const raw = atob(input);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

export function useJupiterPerpsClosePosition({
  signTransaction,
}: UseJupiterPerpsClosePositionOptions): UseJupiterPerpsClosePositionResult {
  const [closingPositionPubkey, setClosingPositionPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const closePosition = useCallback(async ({
    maxSlippageBps = "100",
    positionPubkey,
    receiveToken,
  }: ClosePositionParams) => {
    if (!signTransaction) {
      throw new Error("A connected Jupiter wallet is required to sign the close request.");
    }

    setClosingPositionPubkey(positionPubkey);
    setError(null);

    try {
      const closeResponse = await fetch("/api/jupiter/perps/close", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          positionPubkey,
          receiveToken,
          maxSlippageBps,
          entirePosition: true,
        }),
      });

      const closePayload = await closeResponse.json().catch(() => null) as CreateCloseTransactionResponse | null;
      if (!closeResponse.ok) {
        throw new Error(closePayload?.error || "Jupiter did not return a close transaction.");
      }

      const serializedTxBase64 = closePayload?.serializedTxBase64?.trim();
      if (!serializedTxBase64) {
        throw new Error("Jupiter did not return a close transaction.");
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
          action: "decrease-position",
          serializedTxBase64: signedSerializedTxBase64,
        }),
      });

      const executePayload = await executeResponse.json().catch(() => null) as ExecuteSignedTransactionResponse | null;
      if (!executeResponse.ok) {
        throw new Error(executePayload?.error || "Jupiter could not execute the signed close transaction.");
      }

      const txid = executePayload?.txid?.trim();
      if (!txid) {
        throw new Error("Jupiter did not return a close transaction signature.");
      }

      return { txid };
    } catch (closeError) {
      const message = closeError instanceof Error ? closeError.message : "Unable to close the Jupiter Perps position.";
      setError(message);
      throw closeError;
    } finally {
      setClosingPositionPubkey(null);
    }
  }, [signTransaction]);

  return {
    closePosition,
    closingPositionPubkey,
    error,
    clearError,
  };
}
