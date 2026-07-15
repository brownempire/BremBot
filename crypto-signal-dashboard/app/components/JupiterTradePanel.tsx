"use client";

import { useEffect, useMemo, useRef } from "react";

import "@jup-ag/plugin/css";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_SWAP_TRIGGER_REFERRAL_ACCOUNT = "861hxXDmQiwY8Undw5VCvGSEP1LQxyzjthWDvJRjagUg";
// Ultra dashboard referral account captured for a future wallet migration to the Ultra API:
// 12PJUAzwcBKf1qgXkXTJpZXJTsTS2GhozyQPSSuhY5Th
const DEFAULT_JUPITER_REFERRAL_FEE_BPS = 50;

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
  passthroughWalletContextState?: unknown;
  onRequestConnectWallet?: () => void | Promise<void>;
};

function getInitialOutputMint(defaultInputMint: string) {
  return defaultInputMint === USDC_MINT ? SOL_MINT : USDC_MINT;
}

function getJupiterReferralFeeBps() {
  const value = Number(process.env.NEXT_PUBLIC_JUPITER_REFERRAL_FEE_BPS ?? DEFAULT_JUPITER_REFERRAL_FEE_BPS);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function JupiterTradePanel({
  onTradeSuccess,
  defaultInputMint = SOL_MINT,
  integratedTargetId = "target-container",
  passthroughWalletContextState,
  onRequestConnectWallet,
}: JupiterTradePanelProps) {
  const onTradeSuccessRef = useRef(onTradeSuccess);
  const onRequestConnectWalletRef = useRef(onRequestConnectWallet);
  const integratedTargetIdRef = useRef(integratedTargetId);
  const passthroughWalletContextStateRef = useRef(passthroughWalletContextState);
  const initialOutputMint = useMemo(() => getInitialOutputMint(defaultInputMint), [defaultInputMint]);
  const referralFeeBps = useMemo(() => getJupiterReferralFeeBps(), []);

  useEffect(() => {
    onTradeSuccessRef.current = onTradeSuccess;
  }, [onTradeSuccess]);

  useEffect(() => {
    onRequestConnectWalletRef.current = onRequestConnectWallet;
  }, [onRequestConnectWallet]);

  useEffect(() => {
    integratedTargetIdRef.current = integratedTargetId;
  }, [integratedTargetId]);

  useEffect(() => {
    passthroughWalletContextStateRef.current = passthroughWalletContextState;
  }, [passthroughWalletContextState]);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;

    import("@jup-ag/plugin")
      .then((mod) => {
        if (cancelled) return;
        const target = document.getElementById(integratedTargetIdRef.current);
        if (target) {
          target.replaceChildren();
        }
        mod.close();
        mod.init({
          displayMode: "integrated",
          integratedTargetId,
          enableWalletPassthrough: true,
          passthroughWalletContextState: passthroughWalletContextStateRef.current as never,
          onRequestConnectWallet: async () => {
            await onRequestConnectWalletRef.current?.();
          },
          defaultExplorer: "Solscan",
          formProps: {
            swapMode: "ExactInOrOut",
            initialInputMint: defaultInputMint,
            initialOutputMint,
            referralAccount: JUPITER_SWAP_TRIGGER_REFERRAL_ACCOUNT,
            referralFee: referralFeeBps,
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
  }, [defaultInputMint, initialOutputMint, integratedTargetId, referralFeeBps]);

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
