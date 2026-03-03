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

type JupiterTradePanelProps = {
  onTradeSuccess?: (trade: JupiterTradeRecord) => void;
  defaultInputMint?: string;
  integratedTargetId?: string;
};

export function JupiterTradePanel({
  onTradeSuccess,
  defaultInputMint = "So11111111111111111111111111111111111111112",
  integratedTargetId = "target-container",
}: JupiterTradePanelProps) {
  const wallet = useWallet();
  const onTradeSuccessRef = useRef(onTradeSuccess);

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

  return <div id={integratedTargetId} />;
}
