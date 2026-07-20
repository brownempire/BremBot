import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePerpsPositionLeverage,
  tpslPercentToTriggerPrice,
  triggerPriceToTpslPercent,
} from "../lib/perps/tpslInput";

const longPosition = {
  side: "long" as const,
  entryPrice: 100,
  leverage: 10,
  positionValue: 1_000,
  collateralValue: 100,
};

const shortPosition = { ...longPosition, side: "short" as const };

test("percentage TP and SL convert to the correct long trigger prices", () => {
  assert.equal(tpslPercentToTriggerPrice(longPosition, "tp", 20), 102);
  assert.equal(tpslPercentToTriggerPrice(longPosition, "sl", 20), 98);
});

test("percentage TP and SL convert to the correct short trigger prices", () => {
  assert.equal(tpslPercentToTriggerPrice(shortPosition, "tp", 20), 98);
  assert.equal(tpslPercentToTriggerPrice(shortPosition, "sl", 20), 102);
});

test("trigger prices round-trip through percentage mode", () => {
  const cases = [
    [longPosition, "tp", 102],
    [longPosition, "sl", 98],
    [shortPosition, "tp", 98],
    [shortPosition, "sl", 102],
  ] as const;

  for (const [position, kind, price] of cases) {
    const percent = triggerPriceToTpslPercent(position, kind, price);
    assert.ok(percent !== null);
    assert.ok(Math.abs(percent - 20) < 0.000001);
    assert.ok(Math.abs((tpslPercentToTriggerPrice(position, kind, percent) ?? 0) - price) < 0.000001);
  }
});

test("a negative stop percentage preserves a profit-locking stop", () => {
  assert.equal(tpslPercentToTriggerPrice(longPosition, "sl", -10), 101);
  assert.ok(Math.abs((triggerPriceToTpslPercent(longPosition, "sl", 101) ?? 0) + 10) < 0.000001);
});

test("leverage falls back to position value divided by collateral", () => {
  const position = { ...longPosition, leverage: null, positionValue: 2_000, collateralValue: 100 };
  assert.equal(resolvePerpsPositionLeverage(position), 20);
  assert.equal(tpslPercentToTriggerPrice(position, "tp", 20), 101);
});

test("percentage conversion rejects incomplete or impossible position data", () => {
  assert.equal(tpslPercentToTriggerPrice({ ...longPosition, entryPrice: null }, "tp", 20), null);
  assert.equal(tpslPercentToTriggerPrice({ ...longPosition, leverage: null, positionValue: null }, "tp", 20), null);
  assert.equal(tpslPercentToTriggerPrice(longPosition, "sl", 2_000), null);
  assert.equal(triggerPriceToTpslPercent(longPosition, "tp", 0), null);
});
