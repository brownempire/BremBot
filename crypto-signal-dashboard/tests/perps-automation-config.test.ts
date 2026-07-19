import assert from "node:assert/strict";
import test from "node:test";

import {
  perpsAutomationConfigWriteSchema,
  type PerpsAutomationConfigInput,
} from "../lib/perps/automationConfig";
import { parsePerpsAutomationConfig } from "../lib/perps/automationConfigStore";

const walletAddress = "WalletConfig11111111111111111111111111111111";

function createInput(): PerpsAutomationConfigInput {
  return {
    settings: {
      walletPercent: 10,
      walletAllocationMode: "usd",
      perpsTakeProfitValue: 2,
      perpsTakeProfitMode: "percent",
      spotTakeProfitValue: 1,
      spotTakeProfitMode: "percent",
      stopLossPercent: 1,
      perpsLeverage: 25,
      perpsExecutionMode: "set-parameters",
      decisionMode: "active",
      smartTradeProfile: "balanced",
      slots: [{ id: "slot-sol", token: "SOL" }],
      activeSlotId: null,
      perpsActiveSlotId: "slot-sol",
      mode: "all",
      disableTpLock: false,
    },
    params: {
      trendWindow: 5,
      trendThreshold: 0.25,
      breakoutPercent: 0.5,
      cooldownSeconds: 30,
    },
  };
}

test("legacy wallet automation configs migrate to revision one", () => {
  const input = createInput();
  const { decisionMode: _decisionMode, ...legacySettings } = input.settings;
  const parsed = parsePerpsAutomationConfig(JSON.stringify({
    walletAddress,
    ...input,
    settings: legacySettings,
    updatedAt: new Date().toISOString(),
  }));

  assert.equal(parsed?.revision, 1);
  assert.equal(parsed?.settings.decisionMode, "active");
  assert.equal(parsed?.walletAddress, walletAddress);
});

test("wallet automation writes require a non-negative expected revision", () => {
  assert.equal(perpsAutomationConfigWriteSchema.safeParse({
    ...createInput(),
    expectedRevision: 3,
  }).success, true);
  assert.equal(perpsAutomationConfigWriteSchema.safeParse(createInput()).success, false);
  assert.equal(perpsAutomationConfigWriteSchema.safeParse({
    ...createInput(),
    expectedRevision: -1,
  }).success, false);
});
