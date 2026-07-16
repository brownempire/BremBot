import { z } from "zod";

import type { UserParams } from "@/lib/signal/engine";

export const automationTokenSchema = z.enum(["SOL", "ETH", "BTC", "USDC", "JUP", "BONK"]);

export const perpsAutomationSettingsSchema = z.object({
  walletPercent: z.number().finite().positive().max(1_000_000),
  walletAllocationMode: z.enum(["percent", "usd"]),
  perpsTakeProfitValue: z.number().finite().min(0),
  perpsTakeProfitMode: z.enum(["percent", "usd"]),
  spotTakeProfitValue: z.number().finite().min(0),
  spotTakeProfitMode: z.enum(["percent", "usd"]),
  stopLossPercent: z.number().finite().min(0),
  perpsLeverage: z.number().finite().min(1).max(250),
  perpsExecutionMode: z.enum(["set-parameters", "smart-trades"]),
  smartTradeProfile: z.enum(["conservative", "balanced", "aggressive"]),
  slots: z.array(z.object({
    id: z.string().trim().min(1),
    token: automationTokenSchema,
  })).min(1).max(3),
  activeSlotId: z.string().trim().min(1).nullable(),
  perpsActiveSlotId: z.string().trim().min(1).nullable(),
  mode: z.enum(["all", "buy-only"]),
  disableTpLock: z.boolean(),
});

export const signalParamsSchema = z.object({
  trendWindow: z.number().finite().min(1).max(240),
  trendThreshold: z.number().finite().min(0.01).max(100),
  breakoutPercent: z.number().finite().min(0.01).max(100),
  cooldownSeconds: z.number().finite().min(0).max(86_400),
});

export const perpsAutomationConfigInputSchema = z.object({
  settings: perpsAutomationSettingsSchema,
  params: signalParamsSchema,
});

export const perpsAutomationConfigWriteSchema = perpsAutomationConfigInputSchema.extend({
  expectedRevision: z.number().int().min(0),
});

export const perpsAutomationConfigSchema = perpsAutomationConfigInputSchema.extend({
  walletAddress: z.string().trim().min(1),
  revision: z.number().int().positive().default(1),
  updatedAt: z.string().datetime(),
});

export type PerpsAutomationSettings = z.infer<typeof perpsAutomationSettingsSchema>;
export type PerpsAutomationConfigInput = z.infer<typeof perpsAutomationConfigInputSchema>;
export type PerpsAutomationConfigWrite = z.infer<typeof perpsAutomationConfigWriteSchema>;
export type PerpsAutomationConfig = z.infer<typeof perpsAutomationConfigSchema>;
export type AutomationToken = z.infer<typeof automationTokenSchema>;

export const DEFAULT_SERVER_SIGNAL_PARAMS: UserParams = {
  trendWindow: 5,
  trendThreshold: 0.5,
  breakoutPercent: 0.8,
  cooldownSeconds: 60,
};

export function getActivePerpsAsset(config: PerpsAutomationConfig) {
  const activeSlot = config.settings.slots.find((slot) => slot.id === config.settings.perpsActiveSlotId);
  const token = activeSlot?.token;
  return token === "SOL" || token === "ETH" || token === "BTC" ? token : null;
}
export function isPerpsAutomationEnabled(config: PerpsAutomationConfig) {
  return Boolean(getActivePerpsAsset(config));
}
