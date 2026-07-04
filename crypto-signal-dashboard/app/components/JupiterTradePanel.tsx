"use client";

import { useEffect, useRef } from "react";

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
  passthroughWalletContextState?: unknown;
  onRequestConnectWallet?: () => void | Promise<void>;
};

export function JupiterTradePanel({
  onTradeSuccess,
  defaultInputMint = "So11111111111111111111111111111111111111112",
  integratedTargetId = "target-container",
  tradeRequest = null,
  passthroughWalletContextState,
  onRequestConnectWallet,
}: JupiterTradePanelProps) {
  const onTradeSuccessRef = useRef(onTradeSuccess);
  const onRequestConnectWalletRef = useRef(onRequestConnectWallet);
  const lastHandledRequestId = useRef<string | null>(null);

  useEffect(() => {
    onTradeSuccessRef.current = onTradeSuccess;
  }, [onTradeSuccess]);

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
          integratedTargetId,
          enableWalletPassthrough: true,
          passthroughWalletContextState: passthroughWalletContextState as never,
          onRequestConnectWallet: async () => {
            await onRequestConnectWalletRef.current?.();
          },
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
  }, [defaultInputMint, integratedTargetId, passthroughWalletContextState]);

  useEffect(() => {
    if (!tradeRequest || lastHandledRequestId.current === tradeRequest.id) return;
    lastHandledRequestId.current = tradeRequest.id;
    if (typeof window === "undefined") return;

    import("@jup-ag/plugin")
      .then((mod) => {
        mod.init({
          displayMode: "integrated",
          integratedTargetId,
          enableWalletPassthrough: true,
          passthroughWalletContextState: passthroughWalletContextState as never,
          onRequestConnectWallet: async () => {
            await onRequestConnectWalletRef.current?.();
          },
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
  }, [integratedTargetId, passthroughWalletContextState, tradeRequest]);

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

  return (
    <div className="manual-swap-shell">
      <div className="manual-swap-header">
        <div className="manual-swap-title-row">
          <strong>Manual Swap</strong>
          <span className="perps-readonly-badge">Jupiter</span>
        </div>
      </div>
      <div className="manual-swap-body">
        <div id={integratedTargetId} />
      </div>
    </div>
  );
}
