import { z } from "zod";

export const tradeDecisionTrendBiasSchema = z.enum(["bullish", "bearish", "sideways"]);
export const tradeDecisionRiskGradeSchema = z.enum(["low", "medium", "high"]);

export const tradeDecisionMarketContextSchema = z.object({
  spotPrice: z.number().finite().positive().nullable(),
  volatilityPercent: z.number().finite().min(0).nullable(),
  trendBias: tradeDecisionTrendBiasSchema.nullable(),
  availableUsdc: z.number().finite().min(0).nullable(),
  hasOpenPosition: z.boolean(),
  recentPriceChangePercent: z.number().finite().nullable(),
});

export const tradeDecisionRequestedTradeSchema = z.object({
  collateralUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  takeProfitPrice: z.number().finite().positive().nullable(),
  stopLossPrice: z.number().finite().positive().nullable(),
  maxSlippageBps: z.number().int().positive().max(10_000),
  executionStyle: z.enum(["set-parameters", "smart-trades"]).nullable(),
  smartTradeProfile: z.enum(["conservative", "balanced", "aggressive"]).nullable(),
});

export const tradeDecisionHistoryContextSchema = z.object({
  recentExecutionCount: z.number().int().min(0),
  approvalRequiredCount: z.number().int().min(0),
  submittedCount: z.number().int().min(0),
  confirmedCount: z.number().int().min(0),
  paperExecutedCount: z.number().int().min(0),
  blockedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  recentFailureRate: z.number().finite().min(0).max(1),
  recentBlockedRate: z.number().finite().min(0).max(1),
});

export const tradeDecisionPayloadSchema = z.object({
  decisionId: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  walletAddress: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  sessionMode: z.enum(["paper", "live"]),
  executionModel: z.enum(["approval-assisted", "delegated-ready"]),
  signalId: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  direction: z.enum(["bullish", "bearish"]),
  signalConfidence: z.number().finite().min(0).max(1).nullable(),
  asset: z.enum(["SOL", "ETH", "BTC"]),
  strategyClass: z.enum(["smart", "scalp"]).optional(),
  requestedTrade: tradeDecisionRequestedTradeSchema,
  marketContext: tradeDecisionMarketContextSchema,
  strategyContext: z.object({
    signalType: z.enum(["trend", "breakout", "scalp"]),
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
    scalpSetupType: z.enum(["range-reversal", "liquidity-sweep", "v-reversal", "double-reversal"]).optional(),
    priceActionScore: z.number().finite().min(0).max(1).optional(),
    priceActionTags: z.array(z.string().trim().min(1)).optional(),
    indicatorBypass: z.boolean().optional(),
    detectedDirection: z.enum(["bullish", "bearish"]).optional(),
    directionInverted: z.boolean().optional(),
    directionExperimentId: z.string().trim().min(1).optional(),
    directionExperimentTradeNumber: z.number().int().min(1).max(10).optional(),
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
    learningProfileId: z.string().trim().min(1).nullable(),
  }).nullable().optional(),
  historyContext: tradeDecisionHistoryContextSchema,
  shadowMode: z.boolean(),
});

export const tradeDecisionRecommendationSchema = z.object({
  shouldTrade: z.boolean(),
  confidenceScore: z.number().finite().min(0).max(1),
  riskGrade: tradeDecisionRiskGradeSchema,
  sizeMultiplier: z.number().finite().positive(),
  leverageMultiplier: z.number().finite().positive(),
  recommendedCollateralUsd: z.number().finite().positive(),
  recommendedLeverage: z.number().finite().positive(),
  recommendedTakeProfitPrice: z.number().finite().positive().nullable(),
  recommendedStopLossPrice: z.number().finite().positive().nullable(),
  explanationTags: z.array(z.string().trim().min(1)).min(1),
  explanationSummary: z.string().trim().min(1),
  shadowMode: z.boolean(),
});

export const tradeDecisionRecordSchema = z.object({
  payload: tradeDecisionPayloadSchema,
  recommendation: tradeDecisionRecommendationSchema,
});

export type TradeDecisionPayload = z.infer<typeof tradeDecisionPayloadSchema>;
export type TradeDecisionRecommendation = z.infer<typeof tradeDecisionRecommendationSchema>;
export type TradeDecisionRecord = z.infer<typeof tradeDecisionRecordSchema>;
