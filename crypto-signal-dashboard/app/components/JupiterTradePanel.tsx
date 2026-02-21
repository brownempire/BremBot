"use client";

import { useEffect, useRef } from "react";
import { close, init, syncProps } from "@jup-ag/plugin";
import { useWallet } from "@solana/wallet-adapter-react";

import "@jup-ag/plugin/css";

export function JupiterTradePanel() {
  const wallet = useWallet();
  const initialized = useRef(false);

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
