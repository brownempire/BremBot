import fs from "node:fs";
import crypto from "node:crypto";

import { getRedisClient } from "@/lib/server/redis";

export type StoredPerpsApproval = {
  id: string;
  walletAddress: string;
  signalId: string;
  signalSummary: string;
  symbol: string;
  status: "pending" | "opened" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  request: {
    asset: "BTC" | "ETH" | "SOL";
    collateralToken: "BTC" | "ETH" | "SOL" | "USDC";
    leverage: string;
    maxSlippageBps?: string;
    side: "long" | "short";
    stopLossPrice?: number | null;
    takeProfitPrice?: number | null;
    uiAmount: number;
  };
  openedTxid?: string | null;
  failureReason?: string | null;
};

const STORE_FILE_PATH = process.env.PERPS_APPROVALS_FILE || "/tmp/brembot-perps-approvals.json";
const REDIS_APPROVALS_KEY = "brembot:perps:approvals";
const MAX_APPROVALS = 200;

function readStore(): StoredPerpsApproval[] {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return [];
    const raw = fs.readFileSync(STORE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StoredPerpsApproval[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(approvals: StoredPerpsApproval[]) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(approvals), "utf8");
  } catch {
    // Keep notification flow non-fatal in restricted environments.
  }
}

async function readRedisStore() {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const entries = await client.hVals(REDIS_APPROVALS_KEY);
  return entries
    .map((entry) => {
      try {
        return JSON.parse(entry) as StoredPerpsApproval;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is StoredPerpsApproval => Boolean(entry?.id));
}

async function writeRedisEntries(approvals: StoredPerpsApproval[]) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  const multi = client.multi();
  approvals.forEach((approval) => {
    multi.hSet(REDIS_APPROVALS_KEY, approval.id, JSON.stringify(approval));
  });
  await multi.exec();
  return true;
}

export async function listPerpsApprovals() {
  const redisApprovals = await readRedisStore();
  if (redisApprovals) {
    return redisApprovals.sort((left, right) => right.updatedAt - left.updatedAt);
  }
  return readStore().sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getPerpsApproval(id: string) {
  const approvals = await listPerpsApprovals();
  return approvals.find((approval) => approval.id === id) ?? null;
}

export async function createPerpsApproval(input: Omit<StoredPerpsApproval, "id" | "createdAt" | "updatedAt" | "status">) {
  const approvals = await listPerpsApprovals();
  const now = Date.now();
  const approval: StoredPerpsApproval = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "pending",
  };
  const next = [approval, ...approvals].slice(0, MAX_APPROVALS);
  const wroteRedis = await writeRedisEntries(next);
  if (!wroteRedis) writeStore(next);
  return approval;
}

export async function updatePerpsApproval(
  id: string,
  patch: Partial<Pick<StoredPerpsApproval, "status" | "openedTxid" | "failureReason">>
) {
  const approvals = await listPerpsApprovals();
  const next = approvals.map((approval) => {
    if (approval.id !== id) return approval;
    return {
      ...approval,
      ...patch,
      updatedAt: Date.now(),
    };
  });
  const updated = next.find((approval) => approval.id === id) ?? null;
  const wroteRedis = await writeRedisEntries(next);
  if (!wroteRedis) writeStore(next);
  return updated;
}
