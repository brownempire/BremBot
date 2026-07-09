import { z } from "zod";

export const perpsSessionStateSchema = z.enum(["clocked_in", "clocked_out"]);
export const perpsSessionModeSchema = z.enum(["paper", "live"]);
export const perpsExecutionModelSchema = z.enum(["approval-assisted", "delegated-ready"]);

export const perpsClockInSchema = z.object({
  mode: perpsSessionModeSchema,
  unlimitedSession: z.boolean().optional(),
  appOpen: z.boolean().optional(),
  platform: z.enum(["native", "web", "pwa"]).optional(),
  walletProvider: z.string().trim().min(1).optional(),
});

export const perpsSessionHeartbeatSchema = z.object({
  appOpen: z.boolean(),
  appForeground: z.boolean(),
  walletConnected: z.boolean(),
  walletWriteEnabled: z.boolean().optional(),
  reason: z.string().trim().min(1).optional(),
});

export const perpsAgentSignalSchema = z.object({
  signalId: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  direction: z.enum(["bullish", "bearish"]),
  asset: z.enum(["SOL", "ETH", "BTC"]),
  collateralUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  takeProfitPrice: z.number().finite().positive().nullable().optional(),
  stopLossPrice: z.number().finite().positive().nullable().optional(),
  maxSlippageBps: z.number().int().positive().max(10_000),
  smartTradeProfile: z.enum(["conservative", "balanced", "aggressive"]).optional(),
  executionStyle: z.enum(["set-parameters", "smart-trades"]).optional(),
});

export const perpsExecutionAckSchema = z.object({
  executionId: z.string().trim().min(1),
  status: z.enum(["approval_required", "submitted", "confirmed", "failed", "paper_executed", "blocked", "cancelled"]),
  txid: z.string().trim().nullable().optional(),
  errorMessage: z.string().trim().nullable().optional(),
  positionPubkey: z.string().trim().nullable().optional(),
});

export const perpsAutomationSessionSchema = z.object({
  sessionId: z.string(),
  walletAddress: z.string(),
  sessionState: perpsSessionStateSchema,
  startedAt: z.string().datetime().nullable(),
  lastHeartbeatAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  mode: perpsSessionModeSchema,
  executionModel: perpsExecutionModelSchema,
  appOpen: z.boolean(),
  appForeground: z.boolean(),
  walletConnected: z.boolean(),
  walletWriteEnabled: z.boolean(),
  killSwitch: z.boolean(),
  unlimitedSession: z.boolean(),
  platform: z.enum(["native", "web", "pwa"]).nullable(),
  walletProvider: z.string().nullable(),
  warning: z.string().nullable(),
});

export const perpsUserExecutionSchema = z.object({
  executionId: z.string(),
  sessionId: z.string(),
  walletAddress: z.string(),
  signalId: z.string(),
  symbol: z.string(),
  summary: z.string(),
  side: z.enum(["long", "short"]),
  asset: z.enum(["SOL", "ETH", "BTC"]),
  mode: perpsSessionModeSchema,
  executionModel: perpsExecutionModelSchema,
  status: z.enum(["prepared", "approval_required", "submitted", "confirmed", "failed", "paper_executed", "blocked", "cancelled"]),
  reasonCode: z.string(),
  reasonMessage: z.string(),
  collateralUsd: z.number().finite().positive(),
  sizeUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  takeProfitPrice: z.number().finite().positive().nullable(),
  stopLossPrice: z.number().finite().positive().nullable(),
  txid: z.string().nullable(),
  errorMessage: z.string().nullable().optional(),
  positionPubkey: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PerpsClockInInput = z.infer<typeof perpsClockInSchema>;
export type PerpsSessionHeartbeatInput = z.infer<typeof perpsSessionHeartbeatSchema>;
export type PerpsAutomationSession = z.infer<typeof perpsAutomationSessionSchema>;
export type PerpsAgentSignal = z.infer<typeof perpsAgentSignalSchema>;
export type PerpsUserExecution = z.infer<typeof perpsUserExecutionSchema>;
