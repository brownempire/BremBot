import webpush from "web-push";
import { listSubscriptions, removeSubscription, type PushSubscriptionRecord } from "@/lib/push/store";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:dev@example.com";

export function getWebPushConfigError() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return "Missing VAPID keys";
  return null;
}

export function hasWebPushConfig() {
  return !getWebPushConfigError();
}

function setupWebPush() {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
}

export async function getTargetSubscriptions(options?: {
  subscription?: PushSubscriptionJSON | null;
  walletAddress?: string | null;
}) {
  if (options?.subscription?.endpoint) return [options.subscription];

  const subscriptions = await listSubscriptions();
  const walletAddress = options?.walletAddress?.trim();
  if (!walletAddress) return subscriptions;

  const walletSubscriptions = subscriptions.filter((subscription) => subscription.walletAddress === walletAddress);
  return walletSubscriptions.length > 0 ? walletSubscriptions : subscriptions;
}

export async function sendPushPayload(
  subscriptions: Array<PushSubscriptionJSON | PushSubscriptionRecord>,
  payload: Record<string, unknown>
) {
  setupWebPush();
  const body = JSON.stringify(payload);

  const results = await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as any, body);
        return { endpoint: sub.endpoint, ok: true };
      } catch (error: unknown) {
        const statusCode = typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: number }).statusCode)
          : 0;
        if (statusCode === 404 || statusCode === 410) {
          await removeSubscription(String(sub.endpoint ?? ""));
        }
        return { endpoint: sub.endpoint, ok: false, statusCode };
      }
    })
  );

  const sent = results.filter((result) => result.ok).length;
  return { sent, results };
}
