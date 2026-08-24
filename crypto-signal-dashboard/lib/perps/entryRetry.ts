import { PerpsExecutionError } from "@/lib/perps/errors";
import type { PerpsSignalPayload } from "@/lib/perps/types";

const RETRY_MULTIPLIERS = [1, 0.75, 0.5] as const;

type BuiltEntry = {
  serializedTxBase64: string;
  positionPubkey: string | null;
  tpslMode: "none" | "bundled" | "deferred";
};

type SubmittedEntry = {
  txid?: string | null;
  positionPubkey?: string | null;
};

function round(value: number, fractionDigits: number) {
  return Number(value.toFixed(fractionDigits));
}

export function createPerpsEntryRetrySignals(
  signal: PerpsSignalPayload,
  options: { minimumLeverage?: number } = {}
) {
  const minimumLeverage = typeof options.minimumLeverage === "number"
    && Number.isFinite(options.minimumLeverage)
    ? Math.max(1, options.minimumLeverage)
    : 1;
  const multipliers = RETRY_MULTIPLIERS.filter((multiplier) => (
    round(signal.leverage * multiplier, 2) >= minimumLeverage
  ));
  return multipliers.map((multiplier, index) => {
    const collateralUsd = signal.collateralUsd === 12
      ? 12
      : Math.max(0.000001, round(signal.collateralUsd * multiplier, 6));
    const leverage = Math.max(1, round(signal.leverage * multiplier, 2));
    return {
      ...signal,
      collateralUsd,
      leverage,
      sizeUsd: round(collateralUsd * leverage, 2),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reason: index === 0
        ? signal.reason
        : `${signal.reason} Parameter retry ${index + 1} of ${multipliers.length}.`,
    } satisfies PerpsSignalPayload;
  });
}

function isDefinitelyRejectedParameterSubmission(error: unknown) {
  if (!(error instanceof PerpsExecutionError)) return false;
  if (error.code !== "JUPITER_EXECUTE_FAILED" || ![400, 422].includes(error.status)) return false;
  return /amount|collateral|leverage|parameter|position|price|quote|size|slippage|stop.?loss|take.?profit|tpsl|trigger/i.test(error.message);
}

function isRetryableBuildFailure(error: unknown) {
  if (!(error instanceof PerpsExecutionError)) return true;
  return ![
    "INVALID_TRADING_WALLET_KEY",
    "MARKET_NOT_SUPPORTED",
    "MISSING_TRADING_WALLET_KEY",
    "SIGNER_MISMATCH",
  ].includes(error.code);
}

export async function executePerpsEntryWithRetries(input: {
  signal: PerpsSignalPayload;
  minimumLeverage?: number;
  build: (signal: PerpsSignalPayload) => Promise<BuiltEntry>;
  sign: (serializedTxBase64: string) => string;
  submit: (signedSerializedTxBase64: string) => Promise<SubmittedEntry>;
}) {
  const attempts = createPerpsEntryRetrySignals(input.signal, {
    minimumLeverage: input.minimumLeverage,
  });
  const failures: string[] = [];

  if (attempts.length === 0) {
    throw new PerpsExecutionError(
      "ENTRY_LEVERAGE_BELOW_MINIMUM",
      `The requested ${input.signal.leverage.toFixed(2)}x leverage is below the required ${(input.minimumLeverage ?? 1).toFixed(2)}x execution floor.`,
      422
    );
  }

  for (let index = 0; index < attempts.length; index += 1) {
    const attemptSignal = attempts[index]!;
    let built: BuiltEntry;
    try {
      built = await input.build(attemptSignal);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Jupiter rejected the entry parameters.");
      if (index >= attempts.length - 1 || !isRetryableBuildFailure(error)) throw error;
      continue;
    }

    const signedSerializedTxBase64 = input.sign(built.serializedTxBase64);
    try {
      const submitted = await input.submit(signedSerializedTxBase64);
      if (!submitted.txid) {
        throw new PerpsExecutionError(
          "AMBIGUOUS_SUBMISSION_RESULT",
          "Jupiter did not return a transaction signature; no automatic retry was attempted to avoid a duplicate position.",
          502
        );
      }
      return {
        signal: attemptSignal,
        built,
        submitted,
        attemptCount: index + 1,
        failures,
      };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Jupiter rejected the submitted entry.");
      if (index >= attempts.length - 1 || !isDefinitelyRejectedParameterSubmission(error)) throw error;
    }
  }

  throw new PerpsExecutionError(
    "ENTRY_RETRIES_EXHAUSTED",
    `Jupiter rejected all ${attempts.length} floor-compliant parameter attempt${attempts.length === 1 ? "" : "s"}.`,
    422
  );
}
