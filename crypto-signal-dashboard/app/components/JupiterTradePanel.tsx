"use client";

import { useEffect, useRef } from "react";
import { init, syncProps } from "@jup-ag/plugin";
import { useWallet } from "@solana/wallet-adapter-react";

import "@jup-ag/plugin/css";

const TARGET_ID = "jupiter-plugin-container";

export function JupiterTradePanel() {
  const wallet = useWallet();
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;

    init({
      displayMode: "integrated",
      integratedTargetId: TARGET_ID,
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
  }, [wallet]);

  useEffect(() => {
    if (!initialized.current) return;
    syncProps({
      enableWalletPassthrough: true,
      passthroughWalletContextState: wallet,
    });
  }, [wallet]);

  return <div id={TARGET_ID} className="jupiter-plugin" />;
}
