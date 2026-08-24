import assert from "node:assert/strict";
import test from "node:test";

import {
  isExceptionalScalpLeverageSetup,
  resolveScalpTradeLeverage,
  SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE,
  SCALP_MINIMUM_LEVERAGE,
  SCALP_NORMAL_MAXIMUM_LEVERAGE,
} from "../lib/perps/scalpLeverage";

test("legacy learned quality is translated into the 25-40x normal scalp band", () => {
  assert.equal(resolveScalpTradeLeverage({ learnedLeverage: 2, learnedFloor: 2, learnedCap: 20, exceptional: false }), 25);
  assert.equal(resolveScalpTradeLeverage({ learnedLeverage: 11, learnedFloor: 2, learnedCap: 20, exceptional: false }), 32.5);
  assert.equal(resolveScalpTradeLeverage({ learnedLeverage: 20, learnedFloor: 2, learnedCap: 20, exceptional: false }), 40);
  assert.equal(SCALP_MINIMUM_LEVERAGE, 25);
  assert.equal(SCALP_NORMAL_MAXIMUM_LEVERAGE, 40);
});

test("only an independently exceptional setup can enter the 40-50x tier", () => {
  const exceptional = isExceptionalScalpLeverageSetup({
    entryPath: "continuation",
    confidence: 0.9,
    priceActionScore: 0.92,
    indicatorScore: 5,
    indicatorBypass: false,
    adx: 30,
    volumeRatio: 1.2,
  });
  const ordinary = isExceptionalScalpLeverageSetup({
    entryPath: "continuation",
    confidence: 0.84,
    priceActionScore: 0.92,
    indicatorScore: 5,
    indicatorBypass: false,
    adx: 30,
    volumeRatio: 1.2,
  });

  assert.equal(exceptional, true);
  assert.equal(ordinary, false);
  assert.equal(resolveScalpTradeLeverage({ learnedLeverage: 20, learnedFloor: 2, learnedCap: 20, exceptional }), 50);
  assert.equal(resolveScalpTradeLeverage({ learnedLeverage: 20, learnedFloor: 2, learnedCap: 20, exceptional: ordinary }), 40);
  assert.equal(SCALP_EXCEPTIONAL_MAXIMUM_LEVERAGE, 50);
});

test("exceptional reversal leverage requires complete live ADX and volume evidence", () => {
  const base = {
    entryPath: "reversal" as const,
    confidence: 0.9,
    priceActionScore: 0.92,
    indicatorScore: 5,
    indicatorBypass: true,
    adx: 35,
    volumeRatio: 1,
  };

  assert.equal(isExceptionalScalpLeverageSetup(base), true);
  assert.equal(isExceptionalScalpLeverageSetup({ ...base, adx: null }), false);
  assert.equal(isExceptionalScalpLeverageSetup({ ...base, volumeRatio: null }), false);
});
