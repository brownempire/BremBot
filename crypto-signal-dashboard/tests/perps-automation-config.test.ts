import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SERVER_SIGNAL_PARAMS,
  perpsAutomationConfigWriteSchema,
  type PerpsAutomationConfigInput,
} from "../lib/perps/automationConfig";
import { OPERATOR_TRAINING_BASELINE } from "../lib/decision/operatorTrainingBaselineConstants";
import { parsePerpsAutomationConfig } from "../lib/perps/automationConfigStore";

const walletAddress = "WalletConfig11111111111111111111111111111111";

test("server signal defaults match the operator training baseline", () => {
  assert.deepEqual(DEFAULT_SERVER_SIGNAL_PARAMS, OPERATOR_TRAINING_BASELINE.signalParams);
});

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
      scalpModeEnabled: false,
      scalpTakeProfitRoePercent: 25,
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
  const {
    decisionMode: _decisionMode,
    scalpModeEnabled: _scalpModeEnabled,
    scalpTakeProfitRoePercent: _scalpTakeProfitRoePercent,
    ...legacySettings
  } = input.settings;
  const parsed = parsePerpsAutomationConfig(JSON.stringify({
    walletAddress,
    ...input,
    settings: legacySettings,
    updatedAt: new Date().toISOString(),
  }));

  assert.equal(parsed?.revision, 1);
  assert.equal(parsed?.settings.decisionMode, "active");
  assert.equal(parsed?.settings.scalpModeEnabled, false);
  assert.equal(parsed?.settings.scalpTakeProfitRoePercent, 25);
  assert.equal(parsed?.settings.stopLossPercent, 25);
  assert.equal(parsed?.walletAddress, walletAddress);
});

test("saved zero stop losses migrate to the fixed 25% ROE safeguard", () => {
  const input = createInput();
  const parsed = perpsAutomationConfigWriteSchema.parse({
    ...input,
    settings: { ...input.settings, stopLossPercent: 0 },
    expectedRevision: 0,
  });

  assert.equal(parsed.settings.stopLossPercent, 25);
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

test("saved scalp targets use a 25–100% ROE range above the full ladder", () => {
  const input = createInput();
  const parsed = perpsAutomationConfigWriteSchema.safeParse({
    ...input,
    settings: { ...input.settings, scalpTakeProfitRoePercent: 25 },
    expectedRevision: 0,
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success ? parsed.data.settings.scalpTakeProfitRoePercent : null, 25);
  assert.equal(perpsAutomationConfigWriteSchema.safeParse({
    ...input,
    settings: { ...input.settings, scalpTakeProfitRoePercent: 24.99 },
    expectedRevision: 0,
  }).success, false);
  assert.equal(perpsAutomationConfigWriteSchema.safeParse({
    ...input,
    settings: { ...input.settings, scalpTakeProfitRoePercent: 100.01 },
    expectedRevision: 0,
  }).success, false);
});

test("legacy flat-dollar scalp targets migrate to the 25% ROE default", () => {
  const input = createInput();
  const { scalpTakeProfitRoePercent: _scalpTakeProfitRoePercent, ...legacySettings } = input.settings;
  const parsed = perpsAutomationConfigWriteSchema.parse({
    ...input,
    settings: { ...legacySettings, scalpTakeProfitUsd: 3.5 },
    expectedRevision: 0,
  });

  assert.equal(parsed.settings.scalpTakeProfitRoePercent, 25);
});
