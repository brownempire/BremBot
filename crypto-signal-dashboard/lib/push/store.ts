import fs from "node:fs";

export type PushSubscriptionRecord = PushSubscriptionJSON & { id: string };

const STORE_FILE_PATH = process.env.PUSH_SUBSCRIPTIONS_FILE || "/tmp/brembot-push-subscriptions.json";

function readStore(): PushSubscriptionRecord[] {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return [];
    const raw = fs.readFileSync(STORE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PushSubscriptionRecord => {
      return typeof entry?.endpoint === "string" && typeof entry?.id === "string";
    });
  } catch {
    return [];
  }
}

function writeStore(subscriptions: PushSubscriptionRecord[]) {
  try {
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(subscriptions), "utf8");
  } catch {
    // Ignore write failures to avoid breaking API routes in restricted environments.
  }
}

export function addSubscription(sub: PushSubscriptionJSON) {
  const subscriptions = readStore();
  const id = sub.endpoint ?? String(Date.now());
  if (subscriptions.some((existing) => existing.endpoint === sub.endpoint)) {
    return subscriptions;
  }
  const next = [...subscriptions, { ...sub, id }];
  writeStore(next);
  return next;
}

export function removeSubscription(endpoint: string) {
  const subscriptions = readStore();
  const next = subscriptions.filter((existing) => existing.endpoint !== endpoint);
  writeStore(next);
  return next;
}

export function listSubscriptions() {
  return readStore();
}
