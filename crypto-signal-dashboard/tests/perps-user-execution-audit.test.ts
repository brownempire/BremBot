import assert from "node:assert/strict";
import test from "node:test";

import { migrateMissingUserExecutionRecordsToRedis } from "../lib/perps/userExecutionAudit";
import type { PerpsUserExecution } from "../lib/perps/sessionTypes";

function execution(
  executionId: string,
  overrides: Partial<PerpsUserExecution> = {}
): PerpsUserExecution {
  return {
    executionId,
    sessionId: "audit-migration-session",
    walletAddress: "audit-migration-wallet",
    signalId: `signal-${executionId}`,
    symbol: "SOL/USD",
    summary: "Audit migration regression",
    side: "long",
    asset: "SOL",
    mode: "live",
    executionModel: "delegated-ready",
    status: "submitted",
    reasonCode: "ORDER_SUBMITTED",
    reasonMessage: "The order was submitted.",
    collateralUsd: 10,
    sizeUsd: 200,
    leverage: 20,
    takeProfitPrice: 101,
    stopLossPrice: 99,
    txid: "submitted-signature",
    positionPubkey: "submitted-position",
    createdAt: "2026-08-19T12:00:00.000Z",
    updatedAt: "2026-08-19T12:00:00.000Z",
    ...overrides,
  };
}

test("disk audit migration inserts only missing Redis fields and never rolls authoritative state back", async () => {
  const staleLegacyDisk = execution("legacy-record");
  const authoritativeLegacy = execution("legacy-record", {
    status: "closed",
    reasonCode: "POSITION_CLOSED",
    reasonMessage: "The position closed.",
    updatedAt: "2026-08-19T12:30:00.000Z",
  });
  const staleConcurrentDisk = execution("concurrent-record");
  const concurrentRedis = execution("concurrent-record", {
    status: "confirmed",
    reasonCode: "POSITION_CONFIRMED",
    reasonMessage: "The position was confirmed.",
    updatedAt: "2026-08-19T12:20:00.000Z",
  });
  const missingDisk = execution("missing-record");
  const concurrentField = `${concurrentRedis.walletAddress}:${concurrentRedis.executionId}`;
  const missingField = `${missingDisk.walletAddress}:${missingDisk.executionId}`;
  const values = new Map<string, string>([
    [concurrentField, JSON.stringify(concurrentRedis)],
  ]);
  const attemptedFields: string[] = [];

  await migrateMissingUserExecutionRecordsToRedis({
    async hSetNX(_key, field, value) {
      attemptedFields.push(field);
      if (values.has(field)) return false;
      values.set(field, value);
      return true;
    },
  }, [staleLegacyDisk, staleConcurrentDisk, missingDisk], [authoritativeLegacy]);

  assert.deepEqual(attemptedFields, [concurrentField, missingField]);
  assert.deepEqual(JSON.parse(values.get(concurrentField) ?? "null"), concurrentRedis);
  assert.deepEqual(JSON.parse(values.get(missingField) ?? "null"), missingDisk);
  assert.equal(values.has(`${staleLegacyDisk.walletAddress}:${staleLegacyDisk.executionId}`), false);
});
