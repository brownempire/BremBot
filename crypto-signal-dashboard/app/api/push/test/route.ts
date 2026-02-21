import webpush from "web-push";
import { listSubscriptions } from "@/lib/push/store";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:dev@example.com";

export async function POST(request: Request) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing VAPID keys" }),
      { status: 400 }
    );
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  let body: { subscription?: PushSubscriptionJSON } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const subs = body?.subscription ? [body.subscription] : listSubscriptions();
  if (subs.length === 0) {
    return new Response(
      JSON.stringify({ error: "No push subscriptions found. Enable push first." }),
      { status: 400 }
    );
  }

  const payload = JSON.stringify({
    title: "PulseSignal",
    body: "Test push notification from your signal desk.",
    url: "/",
  });

  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as any, payload);
        return { endpoint: sub.endpoint, ok: true };
      } catch (error) {
        return { endpoint: sub.endpoint, ok: false };
      }
    })
  );

  const sent = results.filter((result) => result.ok).length;
  if (sent === 0) {
    return new Response(
      JSON.stringify({ error: "Failed to send push to active subscription(s)." }),
      { status: 500 }
    );
  }

  return new Response(JSON.stringify({ ok: true, sent, results }));
}
