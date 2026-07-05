import fs from "node:fs";

import { getRedisClient } from "@/lib/server/redis";

export type NativePushDeviceRecord = {
  token: string;
  walletAddress?: string | null;
  platform: "ios";
  createdAt: number;
  updatedAt: number;
};

const STORE_FILE_PATH = process.env.NATIVE_PUSH_DEVICES_FILE || "/tmp/brembot-native-push-devices.json";
const REDIS_NATIVE_PUSH_KEY = "brembot:push:native-devices";

function readStore(): NativePushDeviceRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return [];
    const raw = fs.readFileSync(STORE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is NativePushDeviceRecord => typeof entry?.token === "string");
  } catch {
    return [];
  }
}

function writeStore(entries: NativePushDeviceRecord[]) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(entries), "utf8");
  } catch {
    // Ignore write failures in restricted environments.
  }
}

async function readRedisStore(): Promise<NativePushDeviceRecord[] | null> {
  const client = await getRedisClient().catch(() => null);
  if (!client) return null;
  const entries = await client.hVals(REDIS_NATIVE_PUSH_KEY);
  return entries
    .map((entry) => {
      try {
        return JSON.parse(entry) as NativePushDeviceRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is NativePushDeviceRecord => typeof entry?.token === "string");
}

async function writeRedisEntry(record: NativePushDeviceRecord) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  await client.hSet(REDIS_NATIVE_PUSH_KEY, record.token, JSON.stringify(record));
  return true;
}

async function deleteRedisEntry(token: string) {
  const client = await getRedisClient().catch(() => null);
  if (!client) return false;
  await client.hDel(REDIS_NATIVE_PUSH_KEY, token);
  return true;
}

export async function addNativePushDevice(input: {
  token: string;
  walletAddress?: string | null;
  platform?: "ios";
}) {
  const token = input.token.trim();
  if (!token) return [];

  const devices = (await readRedisStore()) ?? readStore();
  const now = Date.now();
  const nextRecord: NativePushDeviceRecord = {
    token,
    walletAddress: input.walletAddress?.trim() || null,
    platform: "ios",
    createdAt: devices.find((entry) => entry.token === token)?.createdAt ?? now,
    updatedAt: now,
  };
  const existingIndex = devices.findIndex((entry) => entry.token === token);
  const next =
    existingIndex >= 0
      ? devices.map((entry, index) => (index === existingIndex ? nextRecord : entry))
      : [...devices, nextRecord];
  const wroteRedis = await writeRedisEntry(nextRecord);
  if (!wroteRedis) writeStore(next);
  return next;
}

export async function removeNativePushDevice(token: string) {
  const next = ((await readRedisStore()) ?? readStore()).filter((entry) => entry.token !== token);
  const deletedRedis = await deleteRedisEntry(token);
  if (!deletedRedis) writeStore(next);
  return next;
}

export async function listNativePushDevices(walletAddress?: string | null) {
  const devices = (await readRedisStore()) ?? readStore();
  const address = walletAddress?.trim();
  if (!address) return devices;
  return devices.filter((entry) => entry.walletAddress === address);
}
