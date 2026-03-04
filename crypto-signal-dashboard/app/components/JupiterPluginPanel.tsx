"use client";

import { useEffect } from "react";

import "@jup-ag/plugin/css";

type JupiterPluginPanelProps = {
  targetId: string;
  fixedMint: string;
  passthroughWalletContextState?: unknown;
  onRequestConnectWallet?: () => void | Promise<void>;
};

export function JupiterPluginPanel({
  targetId,
  fixedMint,
  passthroughWalletContextState,
  onRequestConnectWallet,
}: JupiterPluginPanelProps) {
  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;

    import("@jup-ag/plugin")
      .then((mod) => {
        if (cancelled) return;
        mod.init({
          displayMode: "integrated",
          integratedTargetId: targetId,
          enableWalletPassthrough: true,
          passthroughWalletContextState: passthroughWalletContextState as never,
          onRequestConnectWallet,
          defaultExplorer: "Solscan",
          formProps: {
            swapMode: "ExactInOrOut",
            fixedMint,
          },
          branding: {
            logoUri:
              "https://raw.githubusercontent.com/brownempire/BremBot/refs/heads/main/crypto-signal-dashboard/app/favicon.ico",
            name: "BremLogic",
          },
        }).catch(() => undefined);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      import("@jup-ag/plugin")
        .then((mod) => mod.close())
        .catch(() => undefined);
    };
  }, [fixedMint, onRequestConnectWallet, passthroughWalletContextState, targetId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    import("@jup-ag/plugin")
      .then((mod) => {
        mod.syncProps({
          enableWalletPassthrough: true,
          passthroughWalletContextState: passthroughWalletContextState as never,
        });
      })
      .catch(() => undefined);
  }, [passthroughWalletContextState]);

  return <div id={targetId} />;
}
