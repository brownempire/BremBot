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
};

export function JupiterTradePanel({
  onTradeSuccess,
  defaultInputMint = "So11111111111111111111111111111111111111112",
  integratedTargetId = "target-container",
  tradeRequest = null,
}: JupiterTradePanelProps) {
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
  }, [defaultInputMint, integratedTargetId]);

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
  }, [integratedTargetId, tradeRequest]);

  return (
    <div className="manual-swap-shell">
      <div className="manual-swap-header">
        <div>
          <div className="manual-swap-title-row">
            <strong>Manual Swap</strong>
            <span className="perps-readonly-badge">Jupiter</span>
          </div>
          <div className="subtext">
            BremLogic-branded Jupiter widget for manual spot swaps.
          </div>
        </div>
      </div>
      <div className="manual-swap-body">
        <div id={integratedTargetId} />
      </div>
      <div className="manual-swap-footer">
        <div className="subtext">
          Manual swaps run through the embedded Jupiter widget and keep BremLogic branding in place.
        </div>
      </div>
    </div>
  );
}
