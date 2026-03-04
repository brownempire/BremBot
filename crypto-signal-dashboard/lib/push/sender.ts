import webpush from "web-push";
import { listSubscriptions, removeSubscription } from "@/lib/push/store";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:dev@example.com";

export function getPushConfigError() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return "Missing VAPID keys";
  return null;
}

function setupWebPush() {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
}

export function getTargetSubscriptions(subscription?: PushSubscriptionJSON | null) {
  if (subscription?.endpoint) return [subscription];
  return listSubscriptions();
}

export async function sendPushPayload(
  subscriptions: PushSubscriptionJSON[],
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
          removeSubscription(String(sub.endpoint ?? ""));
        }
        return { endpoint: sub.endpoint, ok: false, statusCode };
      }
    })
  );

  const sent = results.filter((result) => result.ok).length;
  return { sent, results };
}
