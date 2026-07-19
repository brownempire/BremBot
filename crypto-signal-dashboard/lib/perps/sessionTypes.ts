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
  signalConfidence: z.number().finite().min(0).max(1).optional(),
  asset: z.enum(["SOL", "ETH", "BTC"]),
  collateralUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  takeProfitPrice: z.number().finite().positive().nullable().optional(),
  stopLossPrice: z.number().finite().positive().nullable().optional(),
  maxSlippageBps: z.number().int().positive().max(10_000),
  smartTradeProfile: z.enum(["conservative", "balanced", "aggressive"]).optional(),
  executionStyle: z.enum(["set-parameters", "smart-trades"]).optional(),
  strategyContext: z.object({
    signalType: z.enum(["trend", "breakout"]),
    trendWindow: z.number().finite().min(1),
    trendThreshold: z.number().finite().min(0),
    breakoutPercent: z.number().finite().min(0),
    cooldownSeconds: z.number().finite().min(0),
    trendStrengthPercent: z.number().finite(),
    breakoutStrengthPercent: z.number().finite(),
    atrPercent: z.number().finite().min(0),
    indicatorScore: z.number().finite().min(0).optional(),
    indicatorQualified: z.boolean().optional(),
    indicatorTags: z.array(z.string().trim().min(1)).optional(),
    indicators: z.object({
      emaSpreadPercent: z.number().finite().nullable(),
      emaSlopePercent: z.number().finite().nullable(),
      rsi: z.number().finite().nullable(),
      macdLine: z.number().finite().nullable(),
      macdSignal: z.number().finite().nullable(),
      macdHistogram: z.number().finite().nullable(),
      macdHistogramChange: z.number().finite().nullable(),
      adx: z.number().finite().nullable(),
      plusDi: z.number().finite().nullable(),
      minusDi: z.number().finite().nullable(),
      volumeRatio: z.number().finite().nullable(),
      bollingerBandwidthPercent: z.number().finite().nullable(),
      bollingerPosition: z.number().finite().nullable(),
    }).optional(),
    learningProfileId: z.string().trim().min(1).nullable().optional(),
  }).optional(),
  marketContext: z.object({
    spotPrice: z.number().finite().positive().nullable().optional(),
    volatilityPercent: z.number().finite().min(0).nullable().optional(),
    trendBias: z.enum(["bullish", "bearish", "sideways"]).nullable().optional(),
    availableUsdc: z.number().finite().min(0).nullable().optional(),
    hasOpenPosition: z.boolean().optional(),
    recentPriceChangePercent: z.number().finite().nullable().optional(),
  }).optional(),
});

export const perpsExecutionAckSchema = z.object({
  executionId: z.string().trim().min(1),
  status: z.enum(["approval_required", "submitted", "confirmed", "closed", "failed", "paper_executed", "blocked", "cancelled"]),
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
  inactiveSince: z.string().datetime().nullable().optional(),
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
  status: z.enum(["prepared", "approval_required", "submitted", "confirmed", "closed", "failed", "paper_executed", "blocked", "cancelled"]),
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
  decisionConfidence: z.number().finite().min(0).max(1).nullable().optional(),
  decisionShouldTrade: z.boolean().optional(),
  decisionSummary: z.string().trim().nullable().optional(),
  decisionTags: z.array(z.string().trim().min(1)).optional(),
  decisionShadowMode: z.boolean().optional(),
  decisionId: z.string().trim().nullable().optional(),
  attemptCount: z.number().int().min(1).max(3).optional(),
  retrySummary: z.array(z.string().trim().min(1)).max(3).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PerpsClockInInput = z.infer<typeof perpsClockInSchema>;
export type PerpsSessionHeartbeatInput = z.infer<typeof perpsSessionHeartbeatSchema>;
export type PerpsAutomationSession = z.infer<typeof perpsAutomationSessionSchema>;
export type PerpsAgentSignal = z.infer<typeof perpsAgentSignalSchema>;
export type PerpsUserExecution = z.infer<typeof perpsUserExecutionSchema>;
