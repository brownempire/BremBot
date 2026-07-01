"use client";

import { useEffect, useMemo, useState } from "react";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETH_MINT = "7vfCXTUXx5WQXj6Yf8sTG6iM6Aq98J4A4P8M7P8yWfYw";
const BTC_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SOL_RESERVE_BUFFER = 0.01;

type WalletTokenHolding = {
  mint: string;
  amount: number;
  symbol?: string;
  name?: string;
};

type ExecuteSwapResult = {
  txid: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount?: number;
  gasless: boolean;
  signatureFeePayer: string | null;
  status: string;
};

export type ManualSwapSuccess = ExecuteSwapResult & {
  inputSymbol: string;
  outputSymbol: string;
};

type ManualSwapWidgetProps = {
  connected: boolean;
  walletAddress: string | null;
  solBalance: number | null;
  walletTokens: WalletTokenHolding[];
  onExecuteSwap: (params: {
    inputMint: string;
    outputMint: string;
    uiAmount: number;
    slippageBps?: number;
  }) => Promise<ExecuteSwapResult>;
  onTradeSuccess?: (result: ManualSwapSuccess) => void | Promise<void>;
};

type QuotePreview = {
  expectedOutput: number | null;
  gasless: boolean;
  requiresSol: boolean;
  feeBps: number | null;
  priceImpactPct: number | null;
  signatureFeePayer: string | null;
};

const SWAP_TOKEN_OPTIONS = [
  { mint: USDC_MINT, symbol: "USDC", label: "USDC" },
  { mint: SOL_MINT, symbol: "SOL", label: "Solana (SOL)" },
  { mint: ETH_MINT, symbol: "ETH", label: "Ethereum (ETH)" },
  { mint: BTC_MINT, symbol: "BTC", label: "Bitcoin (BTC)" },
  { mint: JUP_MINT, symbol: "JUP", label: "Jupiter (JUP)" },
  { mint: BONK_MINT, symbol: "BONK", label: "Bonk (BONK)" },
];

function mintDecimals(mint: string) {
  if (mint === USDC_MINT || mint === JUP_MINT) return 6;
  if (mint === SOL_MINT) return 9;
  if (mint === ETH_MINT || mint === BTC_MINT) return 8;
  if (mint === BONK_MINT) return 5;
  return 9;
}

function uiToAtomicAmount(uiAmount: number, decimals: number) {
  const safe = Number.isFinite(uiAmount) ? uiAmount : 0;
  const scaled = Math.floor(safe * 10 ** decimals);
  return scaled > 0 ? String(scaled) : "0";
}

function getTokenSymbol(mint: string) {
  return SWAP_TOKEN_OPTIONS.find((option) => option.mint === mint)?.symbol ?? mint.slice(0, 4);
}

export function ManualSwapWidget({
  connected,
  walletAddress,
  solBalance,
  walletTokens,
  onExecuteSwap,
  onTradeSuccess,
}: ManualSwapWidgetProps) {
  const [inputMint, setInputMint] = useState(USDC_MINT);
  const [outputMint, setOutputMint] = useState(SOL_MINT);
  const [amount, setAmount] = useState("25");
  const [slippageBps, setSlippageBps] = useState("100");
  const [preview, setPreview] = useState<QuotePreview | null>(null);
  const [status, setStatus] = useState("Check a quote to see whether Jupiter can sponsor the network fee.");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (inputMint !== outputMint) return;
    const nextOutput = SWAP_TOKEN_OPTIONS.find((option) => option.mint !== inputMint)?.mint ?? SOL_MINT;
    setOutputMint(nextOutput);
  }, [inputMint, outputMint]);

  const inputSymbol = getTokenSymbol(inputMint);
  const outputSymbol = getTokenSymbol(outputMint);
  const availableInputBalance = useMemo(() => {
    if (inputMint === SOL_MINT) {
      return Math.max(0, (solBalance ?? 0) - SOL_RESERVE_BUFFER);
    }
    return walletTokens.find((token) => token.mint === inputMint)?.amount ?? 0;
  }, [inputMint, solBalance, walletTokens]);

  async function previewSwap() {
    if (!connected || !walletAddress) {
      setStatus("Connect the in-app wallet to preview or execute manual swaps.");
      setPreview(null);
      return;
    }

    const uiAmount = Number(amount);
    if (!Number.isFinite(uiAmount) || uiAmount <= 0) {
      setStatus("Enter a swap amount greater than zero.");
      setPreview(null);
      return;
    }

    setIsPreviewing(true);
    setStatus("Fetching Jupiter v2 order preview...");

    try {
      const response = await fetch("/api/trade/jupiter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputMint,
          outputMint,
          amount: uiToAtomicAmount(uiAmount, mintDecimals(inputMint)),
          slippageBps: Number.isFinite(Number(slippageBps)) ? Number(slippageBps) : 100,
          taker: walletAddress,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(String(payload?.error ?? "Quote preview failed"));
      }

      const outAmountAtomic = Number(payload?.outAmount ?? 0);
      const expectedOutput =
        Number.isFinite(outAmountAtomic) && outAmountAtomic > 0
          ? outAmountAtomic / 10 ** mintDecimals(outputMint)
          : null;
      const gasless = Boolean(payload?.gasless);
      const nextPreview: QuotePreview = {
        expectedOutput,
        gasless,
        requiresSol: !gasless,
        feeBps: Number.isFinite(payload?.feeBps) ? Number(payload.feeBps) : null,
        priceImpactPct:
          payload?.priceImpactPct !== null && payload?.priceImpactPct !== undefined
            ? Number(payload.priceImpactPct)
            : null,
        signatureFeePayer:
          typeof payload?.signatureFeePayer === "string" ? payload.signatureFeePayer : walletAddress,
      };
      setPreview(nextPreview);
      setStatus(
        gasless
          ? "Gasless quote available. Jupiter can cover the network fee for this route."
          : "This quote still expects the taker wallet to have a little SOL for fees."
      );
    } catch (error) {
      setPreview(null);
      setStatus(error instanceof Error ? error.message : "Quote preview failed.");
    } finally {
      setIsPreviewing(false);
    }
  }

  async function executeSwap() {
    if (!connected || !walletAddress) {
      setStatus("Connect the in-app wallet before swapping.");
      return;
    }

    const uiAmount = Number(amount);
    if (!Number.isFinite(uiAmount) || uiAmount <= 0) {
      setStatus("Enter a swap amount greater than zero.");
      return;
    }

    setIsSubmitting(true);
    setStatus(`Submitting ${inputSymbol} -> ${outputSymbol} through Jupiter v2...`);

    try {
      const result = await onExecuteSwap({
        inputMint,
        outputMint,
        uiAmount,
        slippageBps: Number.isFinite(Number(slippageBps)) ? Number(slippageBps) : 100,
      });

      setPreview({
        expectedOutput: typeof result.outputAmount === "number" ? result.outputAmount : null,
        gasless: result.gasless,
        requiresSol: !result.gasless,
        feeBps: preview?.feeBps ?? null,
        priceImpactPct: preview?.priceImpactPct ?? null,
        signatureFeePayer: result.signatureFeePayer,
      });
      setStatus(
        result.gasless
          ? `Swap executed gaslessly. Tx ${result.txid.slice(0, 10)}...`
          : `Swap executed. Tx ${result.txid.slice(0, 10)}...`
      );
      await onTradeSuccess?.({
        ...result,
        inputSymbol,
        outputSymbol,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Manual swap failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="manual-swap-shell">
      <div className="manual-swap-header">
        <div>
          <div className="manual-swap-title-row">
            <strong>Manual Swap</strong>
            <span className="perps-readonly-badge">Jupiter v2</span>
          </div>
          <div className="subtext">
            Run a manual spot swap through the same backend path used by auto-trade, with gasless support when Jupiter offers it.
          </div>
        </div>
      </div>

      <div className="manual-swap-body">
        {!connected ? (
          <div className="perps-empty-state">
            <strong>Connect the in-app wallet</strong>
            <span className="subtext">Manual swaps use the same secured wallet flow as auto-trade and only appear live after the in-app wallet is unlocked.</span>
          </div>
        ) : null}

        <div className="manual-swap-form">
          <label>
            From
            <select value={inputMint} onChange={(event) => setInputMint(event.target.value)}>
              {SWAP_TOKEN_OPTIONS.map((option) => (
                <option key={option.mint} value={option.mint}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            To
            <select value={outputMint} onChange={(event) => setOutputMint(event.target.value)}>
              {SWAP_TOKEN_OPTIONS.filter((option) => option.mint !== inputMint).map((option) => (
                <option key={option.mint} value={option.mint}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <div className="manual-swap-amount-row">
              <input
                type="number"
                min="0"
                step="0.000001"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <button
                type="button"
                className="secondary"
                onClick={() => setAmount(Math.max(0, availableInputBalance).toFixed(inputMint === SOL_MINT ? 4 : 6))}
              >
                Max
              </button>
            </div>
          </label>
          <label>
            Slippage (bps)
            <input
              type="number"
              min="10"
              step="10"
              value={slippageBps}
              onChange={(event) => setSlippageBps(event.target.value)}
            />
          </label>
        </div>

        <div className="manual-swap-balance-row">
          <span className="subtext">
            Available {inputSymbol}: {Number.isFinite(availableInputBalance) ? availableInputBalance.toFixed(inputMint === SOL_MINT ? 4 : 6) : "-"}
          </span>
          {inputMint === SOL_MINT ? (
            <span className="subtext">Max leaves ~{SOL_RESERVE_BUFFER.toFixed(2)} SOL for fees when gasless is unavailable.</span>
          ) : null}
        </div>

        {preview ? (
          <div className="manual-swap-quote-card">
            <div className="manual-swap-quote-row">
              <span>Expected output</span>
              <strong>{preview.expectedOutput === null ? "-" : `${preview.expectedOutput.toFixed(6)} ${outputSymbol}`}</strong>
            </div>
            <div className="manual-swap-quote-row">
              <span>Network fee</span>
              <strong className={preview.gasless ? "pnl-positive" : undefined}>
                {preview.gasless ? "Jupiter-sponsored" : "User SOL required"}
              </strong>
            </div>
            <div className="manual-swap-quote-row">
              <span>Total fee</span>
              <strong>{preview.feeBps === null ? "-" : `${preview.feeBps} bps`}</strong>
            </div>
            <div className="manual-swap-quote-row">
              <span>Price impact</span>
              <strong>
                {preview.priceImpactPct === null || Number.isNaN(preview.priceImpactPct)
                  ? "-"
                  : `${preview.priceImpactPct.toFixed(2)}%`}
              </strong>
            </div>
          </div>
        ) : null}

        <div className="perps-inline-banner" role="status">
          {status}
        </div>
      </div>

      <div className="manual-swap-footer">
        <div className="wallet-controls">
          <button type="button" className="secondary" onClick={() => void previewSwap()} disabled={isPreviewing || isSubmitting}>
            {isPreviewing ? "Checking..." : "Check Quote"}
          </button>
          <button type="button" onClick={() => void executeSwap()} disabled={isSubmitting || isPreviewing || !connected}>
            {isSubmitting ? "Swapping..." : "Swap"}
          </button>
        </div>
        <div className="subtext">
          {preview?.gasless
            ? "This route is currently eligible for Jupiter-sponsored gas."
            : "Gasless availability is quote-specific and can change between routes."}
        </div>
      </div>
    </div>
  );
}
