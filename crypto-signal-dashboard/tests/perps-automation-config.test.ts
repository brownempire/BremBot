import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SERVER_SIGNAL_PARAMS,
  getActiveRegularPerpsAsset,
  getActiveScalpAsset,
  isPerpsAutomationEnabled,
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
      scalpActiveSlotId: null,
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
    scalpActiveSlotId: _scalpActiveSlotId,
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
  assert.equal(parsed?.settings.scalpActiveSlotId, null);
  assert.equal(parsed?.settings.scalpTakeProfitRoePercent, 25);
  assert.equal(parsed?.settings.stopLossPercent, 25);
  assert.equal(parsed?.walletAddress, walletAddress);
});

test("legacy enabled Scalp Mode inherits the selected Perps token", () => {
  const input = createInput();
  const { scalpActiveSlotId: _scalpActiveSlotId, ...legacySettings } = input.settings;
  const parsed = parsePerpsAutomationConfig(JSON.stringify({
    walletAddress,
    ...input,
    settings: { ...legacySettings, scalpModeEnabled: true },
    updatedAt: new Date().toISOString(),
  }));

  assert.equal(parsed?.settings.scalpModeEnabled, true);
  assert.equal(parsed?.settings.scalpActiveSlotId, "slot-sol");
});

test("regular Perps and Scalp Agent can be enabled independently", () => {
  const input = createInput();
  const scalpOnly = parsePerpsAutomationConfig(JSON.stringify({
    walletAddress,
    ...input,
    settings: {
      ...input.settings,
      perpsActiveSlotId: null,
      scalpModeEnabled: true,
      scalpActiveSlotId: "slot-sol",
    },
    updatedAt: new Date().toISOString(),
  }));
  assert.ok(scalpOnly);
  assert.equal(getActiveRegularPerpsAsset(scalpOnly), null);
  assert.equal(getActiveScalpAsset(scalpOnly), "SOL");
  assert.equal(isPerpsAutomationEnabled(scalpOnly), true);

  const regularOnly = parsePerpsAutomationConfig(JSON.stringify({
    walletAddress,
    ...input,
    settings: {
      ...input.settings,
      scalpModeEnabled: false,
      scalpActiveSlotId: null,
    },
    updatedAt: new Date().toISOString(),
  }));
  assert.ok(regularOnly);
  assert.equal(getActiveRegularPerpsAsset(regularOnly), "SOL");
  assert.equal(getActiveScalpAsset(regularOnly), null);
  assert.equal(isPerpsAutomationEnabled(regularOnly), true);
});

test("regular Perps and Scalp Agent must share a token when both are enabled", () => {
  const input = createInput();
  assert.equal(perpsAutomationConfigWriteSchema.safeParse({
    ...input,
    settings: {
      ...input.settings,
      slots: [
        { id: "slot-sol", token: "SOL" },
        { id: "slot-eth", token: "ETH" },
      ],
      scalpModeEnabled: true,
      scalpActiveSlotId: "slot-eth",
    },
    expectedRevision: 0,
  }).success, false);
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
