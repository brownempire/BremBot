import { type PerpsExecutionRecord, type PerpsRiskDecision, type PerpsRuntimeSettings, type PerpsSignalPayload } from "@/lib/perps/types";

function roundUsd(value: number) {
  return Number(value.toFixed(2));
}

function deriveOpenExposureUsd(executions: PerpsExecutionRecord[]) {
  const exposureByMarket = new Map<string, number>();

  executions
    .filter((record) => ["risk_approved", "paper_approved", "submitted", "confirmed"].includes(record.status))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .forEach((record) => {
      if (record.action === "open") {
        exposureByMarket.set(record.market, roundUsd((exposureByMarket.get(record.market) ?? 0) + record.sizeUsd));
        return;
      }

      exposureByMarket.set(record.market, 0);
    });

  return roundUsd([...exposureByMarket.values()].reduce((sum, value) => sum + value, 0));
}

export function buildRiskDecision(input: {
  signal: PerpsSignalPayload;
  settings: PerpsRuntimeSettings & { killSwitch: boolean };
  existingExecutions: PerpsExecutionRecord[];
  duplicateNonceSeen: boolean;
}): PerpsRiskDecision {
  const { signal, settings, existingExecutions, duplicateNonceSeen } = input;
  const now = Date.now();
  const duplicateWindowMs = settings.duplicateWindowSeconds * 1000;
  const cooldownMs = settings.cooldownSeconds * 1000;
  const openExposureUsd = deriveOpenExposureUsd(existingExecutions);
  const duplicateSignal = existingExecutions.some((record) => {
    if (record.signalId !== signal.signalId) return false;
    return now - Date.parse(record.createdAt) <= duplicateWindowMs;
  });

  const recentMarketExecution = existingExecutions.find((record) =>
    record.market === signal.market &&
    record.action === "open" &&
    ["risk_approved", "paper_approved", "submitted", "confirmed"].includes(record.status) &&
    now - Date.parse(record.createdAt) <= cooldownMs
  );

  if (settings.killSwitch) {
    return { approved: false, code: "KILL_SWITCH", message: "Perps execution is halted by the kill switch.", openExposureUsd, duplicateSignal };
  }

  if (!settings.allowedMarkets.includes(signal.market.toUpperCase())) {
    return { approved: false, code: "MARKET_NOT_ALLOWED", message: `${signal.market} is not enabled for perps automation.`, openExposureUsd, duplicateSignal };
  }

  if (duplicateSignal || duplicateNonceSeen) {
    return { approved: false, code: "DUPLICATE_SIGNAL", message: "This signal was already processed inside the duplicate protection window.", openExposureUsd, duplicateSignal: true };
  }

  if (new Date(signal.expiresAt).getTime() <= now) {
    return { approved: false, code: "SIGNAL_EXPIRED", message: "The signal expired before it reached the execution engine.", openExposureUsd, duplicateSignal };
  }

  if (signal.maxSlippageBps > settings.maxSlippageBps) {
    return { approved: false, code: "SLIPPAGE_TOO_HIGH", message: `Requested slippage ${signal.maxSlippageBps} bps exceeds the configured maximum of ${settings.maxSlippageBps} bps.`, openExposureUsd, duplicateSignal };
  }

  if (signal.leverage > settings.maxLeverage) {
    return { approved: false, code: "LEVERAGE_TOO_HIGH", message: `Requested leverage ${signal.leverage}x exceeds the configured maximum of ${settings.maxLeverage}x.`, openExposureUsd, duplicateSignal };
  }

  if (signal.sizeUsd > settings.assumedCapitalUsd * settings.maxTradePct) {
    return { approved: false, code: "SIZE_TOO_LARGE", message: `Requested size ${roundUsd(signal.sizeUsd)} USD exceeds the paper trade cap of ${roundUsd(settings.assumedCapitalUsd * settings.maxTradePct)} USD.`, openExposureUsd, duplicateSignal };
  }

  if (signal.action === "open" && openExposureUsd + signal.sizeUsd > settings.assumedCapitalUsd * settings.maxExposurePct) {
    return { approved: false, code: "EXPOSURE_TOO_HIGH", message: `Open exposure would rise to ${roundUsd(openExposureUsd + signal.sizeUsd)} USD, above the configured cap of ${roundUsd(settings.assumedCapitalUsd * settings.maxExposurePct)} USD.`, openExposureUsd, duplicateSignal };
  }

  if (signal.action === "open" && recentMarketExecution) {
    return { approved: false, code: "COOLDOWN", message: `${signal.market} is still inside the ${settings.cooldownSeconds}s cooldown window.`, openExposureUsd, duplicateSignal };
  }

  return { approved: true, code: "APPROVED", message: "Risk checks approved the trade.", openExposureUsd, duplicateSignal };
}
