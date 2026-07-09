import { z } from "zod";

export const perpsSignalHeadersSchema = z.object({
  signature: z.string().trim().optional(),
  timestamp: z.string().trim().optional(),
  nonce: z.string().trim().optional(),
});

export const perpsTriggerSchema = z.object({
  enabled: z.boolean(),
  priceUsd: z.number().finite().positive().nullable().optional(),
});

export const perpsSignalSchema = z.object({
  signalId: z.string().trim().min(1),
  strategyId: z.string().trim().min(1),
  market: z.string().trim().min(1),
  assetMint: z.string().trim().min(1),
  side: z.enum(["long", "short"]),
  action: z.enum(["open", "close"]),
  collateralUsd: z.number().finite().positive(),
  sizeUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  maxSlippageBps: z.number().int().min(1).max(10_000),
  takeProfit: perpsTriggerSchema.optional(),
  stopLoss: perpsTriggerSchema.optional(),
  expiresAt: z.string().datetime(),
  reason: z.string().trim().min(1),
  walletAddress: z.string().trim().min(1).optional(),
  source: z.enum(["ui-local", "webhook"]).optional(),
});

export const perpsExecutionStatusSchema = z.enum([
  "received",
  "risk_approved",
  "risk_blocked",
  "paper_approved",
  "build_tx_requested",
  "build_tx_failed",
  "signed",
  "submitted",
  "confirmed",
  "failed",
  "timeout",
  "unknown",
]);

export const perpsRiskDecisionSchema = z.object({
  approved: z.boolean(),
  code: z.string(),
  message: z.string(),
  openExposureUsd: z.number().finite().nonnegative(),
  duplicateSignal: z.boolean().default(false),
});

export const perpsExecutionRecordSchema = z.object({
  id: z.string(),
  signalId: z.string(),
  strategyId: z.string(),
  market: z.string(),
  assetMint: z.string(),
  side: z.enum(["long", "short"]),
  action: z.enum(["open", "close"]),
  collateralUsd: z.number().finite().positive(),
  sizeUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  maxSlippageBps: z.number().int().min(1).max(10_000),
  reason: z.string(),
  walletAddress: z.string().nullable(),
  source: z.enum(["ui-local", "webhook"]),
  mode: z.enum(["paper", "live"]),
  status: perpsExecutionStatusSchema,
  riskDecision: perpsRiskDecisionSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  takeProfitPriceUsd: z.number().finite().positive().nullable(),
  stopLossPriceUsd: z.number().finite().positive().nullable(),
  txid: z.string().nullable(),
  positionPubkey: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const perpsRuntimeSettingsSchema = z.object({
  killSwitch: z.boolean(),
  paperTrading: z.boolean(),
  allowedMarkets: z.array(z.string()).min(1),
  maxLeverage: z.number().finite().positive(),
  maxTradePct: z.number().finite().positive(),
  maxExposurePct: z.number().finite().positive(),
  maxDailyLossPct: z.number().finite().positive(),
  cooldownSeconds: z.number().int().nonnegative(),
  duplicateWindowSeconds: z.number().int().nonnegative(),
  maxSlippageBps: z.number().int().positive(),
  assumedCapitalUsd: z.number().finite().positive(),
});

export type PerpsSignalHeaders = z.infer<typeof perpsSignalHeadersSchema>;
export type PerpsSignalPayload = z.infer<typeof perpsSignalSchema>;
export type PerpsExecutionStatus = z.infer<typeof perpsExecutionStatusSchema>;
export type PerpsRiskDecision = z.infer<typeof perpsRiskDecisionSchema>;
export type PerpsExecutionRecord = z.infer<typeof perpsExecutionRecordSchema>;
export type PerpsRuntimeSettings = z.infer<typeof perpsRuntimeSettingsSchema>;
