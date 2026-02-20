import webpush from "web-push";
import { listSubscriptions } from "@/lib/push/store";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:dev@example.com";

export async function POST() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing VAPID keys" }),
      { status: 400 }
    );
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const subs = listSubscriptions();
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

  return new Response(JSON.stringify({ ok: true, results }));
}
