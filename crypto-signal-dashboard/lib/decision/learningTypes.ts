import { z } from "zod";

export const learningAssetSchema = z.enum(["SOL", "ETH", "BTC"]);

export const tradeLearningOutcomeSchema = z.object({
  outcomeId: z.string().trim().min(1),
  walletAddress: z.string().trim().min(1),
  executionId: z.string().trim().min(1),
  decisionId: z.string().trim().min(1).nullable(),
  signalId: z.string().trim().min(1),
  asset: learningAssetSchema,
  side: z.enum(["long", "short"]),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime(),
  positionPubkey: z.string().trim().min(1).nullable(),
  entryPrice: z.number().finite().positive().nullable(),
  exitPrice: z.number().finite().positive().nullable(),
  collateralUsd: z.number().finite().positive(),
  sizeUsd: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  takeProfitPrice: z.number().finite().positive().nullable(),
  stopLossPrice: z.number().finite().positive().nullable(),
  grossPnlUsd: z.number().finite(),
  feesUsd: z.number().finite().min(0),
  netPnlUsd: z.number().finite(),
  returnOnCollateralPercent: z.number().finite(),
  durationMinutes: z.number().finite().min(0),
  exitReason: z.enum(["take-profit", "stop-loss", "liquidation", "manual", "unknown"]),
  signalConfidence: z.number().finite().min(0).max(1).nullable(),
  signalType: z.enum(["trend", "breakout"]).nullable(),
  trendWindow: z.number().finite().min(1).nullable(),
  trendThreshold: z.number().finite().min(0).nullable(),
  breakoutPercent: z.number().finite().min(0).nullable(),
  cooldownSeconds: z.number().finite().min(0).nullable(),
  trendStrengthPercent: z.number().finite().nullable(),
  breakoutStrengthPercent: z.number().finite().nullable(),
  volatilityPercent: z.number().finite().min(0).nullable(),
  atrPercent: z.number().finite().min(0).nullable(),
  trendBias: z.enum(["bullish", "bearish", "sideways"]).nullable(),
  createdAt: z.string().datetime(),
});

export const learningValidationSchema = z.object({
  sampleSize: z.number().int().min(0),
  trainingSize: z.number().int().min(0),
  validationSize: z.number().int().min(0),
  winRate: z.number().finite().min(0).max(1),
  expectancyUsd: z.number().finite(),
  profitFactor: z.number().finite().min(0),
  maxDrawdownUsd: z.number().finite().min(0),
  passed: z.boolean(),
  reasons: z.array(z.string()),
});

const learnedAssetAdjustmentSchema = z.object({
  trendThreshold: z.number().finite().min(0.01).max(10),
  breakoutPercent: z.number().finite().min(0.01).max(8),
  leverageMultiplier: z.number().finite().min(0.5).max(1.25),
  allocationMultiplier: z.number().finite().min(0.5).max(1.1),
});

export const decisionLearningProfileSchema = z.object({
  profileId: z.string().trim().min(1),
  walletAddress: z.string().trim().min(1),
  version: z.number().int().positive(),
  status: z.enum(["active", "candidate", "archived"]),
  source: z.enum(["operator-baseline", "automatic", "manual-training"]),
  createdAt: z.string().datetime(),
  promotedAt: z.string().datetime().nullable(),
  learnedFromClosedTrades: z.number().int().min(0),
  minimumConfidence: z.number().finite().min(0.45).max(0.82),
  leverageCap: z.number().finite().min(1).max(125),
  maximumAllocationPercent: z.number().finite().min(1).max(100),
  targetWalletRiskPercent: z.number().finite().min(0.1).max(2),
  preferredDirection: z.enum(["bullish", "bearish", "balanced"]),
  trendWindow: z.number().int().min(5).max(180),
  cooldownSeconds: z.number().int().min(30).max(3_600),
  takeProfitRoePercent: z.number().finite().min(1).max(12),
  stopLossRoePercent: z.number().finite().min(0.5).max(6),
  minimumRewardRiskRatio: z.number().finite().min(1.25).max(4),
  atrLookback: z.number().int().min(7).max(30),
  atrStopMultiplier: z.number().finite().min(1).max(3),
  volatilityCeilingPercent: z.number().finite().min(1.5).max(10),
  assetAdjustments: z.object({
    SOL: learnedAssetAdjustmentSchema,
    ETH: learnedAssetAdjustmentSchema,
    BTC: learnedAssetAdjustmentSchema,
  }),
  validation: learningValidationSchema,
  summary: z.string().trim().min(1),
});

export type TradeLearningOutcome = z.infer<typeof tradeLearningOutcomeSchema>;
export type DecisionLearningProfile = z.infer<typeof decisionLearningProfileSchema>;
export type LearningAsset = z.infer<typeof learningAssetSchema>;
