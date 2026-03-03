"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import "@jup-ag/plugin/css";

export type JupiterTradeRecord = {
  txid: string;
  timestamp: number;
  walletAddress?: string;
  inputMint?: string;
  outputMint?: string;
  inputAmount?: number;
  outputAmount?: number;
};

export type JupiterTradeRequest = {
  id: string;
  inputMint: string;
  outputMint: string;
};

type JupiterTradePanelProps = {
  onTradeSuccess?: (trade: JupiterTradeRecord) => void;
  defaultInputMint?: string;
  integratedTargetId?: string;
  tradeRequest?: JupiterTradeRequest | null;
};

export function JupiterTradePanel({
  onTradeSuccess,
  defaultInputMint = "So11111111111111111111111111111111111111112",
  integratedTargetId = "target-container",
  tradeRequest = null,
}: JupiterTradePanelProps) {
  const wallet = useWallet();
  const onTradeSuccessRef = useRef(onTradeSuccess);
  const lastHandledRequestId = useRef<string | null>(null);

  useEffect(() => {
    onTradeSuccessRef.current = onTradeSuccess;
  }, [onTradeSuccess]);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;

    import("@jup-ag/plugin")
      .then((mod) => {
        if (cancelled) return;
        mod.init({
          displayMode: "integrated",
          integratedTargetId,
          defaultExplorer: "Solscan",
          formProps: {
            swapMode: "ExactInOrOut",
            fixedMint: defaultInputMint,
          },
          branding: {
            logoUri:
              "https://raw.githubusercontent.com/brownempire/BremBot/refs/heads/main/crypto-signal-dashboard/app/favicon.ico",
            name: "BremLogic",
          },
          onSuccess: ({ txid, quoteResponseMeta }) => {
            const quote = quoteResponseMeta?.quoteResponse;
            onTradeSuccessRef.current?.({
              txid,
              timestamp: Date.now(),
              walletAddress: wallet.publicKey?.toBase58(),
              inputMint: quote?.inputMint?.toString?.(),
              outputMint: quote?.outputMint?.toString?.(),
              inputAmount: Number(quote?.inAmount ?? 0),
              outputAmount: Number(quote?.outAmount ?? 0),
            });
          },
        }).catch(() => undefined);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      import("@jup-ag/plugin")
        .then((mod) => {
          mod.close();
        })
        .catch(() => undefined);
    };
  }, [defaultInputMint, integratedTargetId, wallet.publicKey]);

  useEffect(() => {
    if (!tradeRequest || lastHandledRequestId.current === tradeRequest.id) return;
    lastHandledRequestId.current = tradeRequest.id;
    if (typeof window === "undefined") return;

    import("@jup-ag/plugin")
      .then((mod) => {
        mod.init({
          displayMode: "integrated",
          integratedTargetId,
          defaultExplorer: "Solscan",
          formProps: {
            swapMode: "ExactInOrOut",
            fixedMint: tradeRequest.inputMint,
            initialOutputMint: tradeRequest.outputMint,
          },
          branding: {
            logoUri:
              "https://raw.githubusercontent.com/brownempire/BremBot/refs/heads/main/crypto-signal-dashboard/app/favicon.ico",
            name: "BremLogic",
          },
          onSuccess: ({ txid, quoteResponseMeta }) => {
            const quote = quoteResponseMeta?.quoteResponse;
            onTradeSuccessRef.current?.({
              txid,
              timestamp: Date.now(),
              walletAddress: wallet.publicKey?.toBase58(),
              inputMint: quote?.inputMint?.toString?.(),
              outputMint: quote?.outputMint?.toString?.(),
              inputAmount: Number(quote?.inAmount ?? 0),
              outputAmount: Number(quote?.outAmount ?? 0),
            });
          },
        }).catch(() => undefined);
        mod.resume();
      })
      .catch(() => undefined);
  }, [integratedTargetId, tradeRequest, wallet.publicKey]);

  return <div id={integratedTargetId} />;
}
