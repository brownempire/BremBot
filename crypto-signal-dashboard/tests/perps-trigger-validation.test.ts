import assert from "node:assert/strict";
import test from "node:test";

import { validatePerpsTriggerPriceAgainstMark } from "../lib/perps/triggerValidation";

test("a long position can lock in profit with a stop above entry but below mark", () => {
  assert.equal(validatePerpsTriggerPriceAgainstMark({
    kind: "sl",
    markPrice: 77,
    side: "long",
    triggerPrice: 76.2,
  }), null);
});

test("a short position can lock in profit with a stop below entry but above mark", () => {
  assert.equal(validatePerpsTriggerPriceAgainstMark({
    kind: "sl",
    markPrice: 74,
    side: "short",
    triggerPrice: 75,
  }), null);
});

test("TP and SL direction is validated against mark instead of entry", () => {
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "tp", markPrice: 77, side: "long", triggerPrice: 78 }), null);
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "tp", markPrice: 77, side: "long", triggerPrice: 76 }), "tp-must-be-above-mark");
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "sl", markPrice: 77, side: "long", triggerPrice: 78 }), "sl-must-be-below-mark");
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "tp", markPrice: 74, side: "short", triggerPrice: 73 }), null);
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "tp", markPrice: 74, side: "short", triggerPrice: 75 }), "tp-must-be-below-mark");
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "sl", markPrice: 74, side: "short", triggerPrice: 73 }), "sl-must-be-above-mark");
});

test("Jupiter performs final directional validation when mark is unavailable", () => {
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "sl", markPrice: null, side: "long", triggerPrice: 76.2 }), null);
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "tp", markPrice: null, side: "short", triggerPrice: 73 }), null);
  assert.equal(validatePerpsTriggerPriceAgainstMark({ kind: "tp", markPrice: null, side: "long", triggerPrice: 0 }), "invalid-price");
});
