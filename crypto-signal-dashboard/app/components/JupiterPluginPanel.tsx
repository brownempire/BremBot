"use client";

import { useEffect, useRef } from "react";

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
  const onRequestConnectWalletRef = useRef(onRequestConnectWallet);

  useEffect(() => {
    onRequestConnectWalletRef.current = onRequestConnectWallet;
  }, [onRequestConnectWallet]);

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
          onRequestConnectWallet: async () => {
            await onRequestConnectWalletRef.current?.();
          },
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
  }, [fixedMint, targetId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    import("@jup-ag/plugin")
      .then((mod) => {
        mod.syncProps({
          enableWalletPassthrough: true,
          passthroughWalletContextState: passthroughWalletContextState as never,
        });
        if (window.Jupiter) {
          window.Jupiter.enableWalletPassthrough = true;
          window.Jupiter.onRequestConnectWallet = async () => {
            await onRequestConnectWalletRef.current?.();
          };
        }
      })
      .catch(() => undefined);
  }, [passthroughWalletContextState]);

  return <div id={targetId} />;
}
