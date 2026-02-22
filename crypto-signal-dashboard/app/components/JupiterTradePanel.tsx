"use client";

import { useEffect, useRef } from "react";
import { close, init, syncProps } from "@jup-ag/plugin";
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
};

export function JupiterTradePanel({ onTradeSuccess }: JupiterTradePanelProps) {
  const wallet = useWallet();
  const initialized = useRef(false);
  const onTradeSuccessRef = useRef(onTradeSuccess);

  useEffect(() => {
    onTradeSuccessRef.current = onTradeSuccess;
  }, [onTradeSuccess]);

  useEffect(() => {
    if (initialized.current) return;

    init({
      displayMode: "widget",
      widgetStyle: {
        position: "bottom-right",
        offset: {
          x: 50,
          y: 100,
        },
      },
      enableWalletPassthrough: true,
      passthroughWalletContextState: wallet,
      onRequestConnectWallet: async () => {
        if (!wallet.connected) {
          await wallet.connect();
        }
      },
      defaultExplorer: "Solscan",
      formProps: {
        initialInputMint: "So11111111111111111111111111111111111111112",
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

    initialized.current = true;

    return () => {
      close();
      initialized.current = false;
    };
  }, [wallet]);

  useEffect(() => {
    if (!initialized.current) return;
    syncProps({
      enableWalletPassthrough: true,
      passthroughWalletContextState: wallet,
    });
  }, [wallet]);

  return null;
}
