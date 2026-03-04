import { getPushConfigError, getTargetSubscriptions, sendPushPayload } from "@/lib/push/sender";

export async function POST(request: Request) {
  const configError = getPushConfigError();
  if (configError) {
    return new Response(
      JSON.stringify({ error: configError }),
      { status: 400 }
    );
  }

  let body: { subscription?: PushSubscriptionJSON } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const subs = getTargetSubscriptions(body?.subscription ?? null);
  if (subs.length === 0) {
    return new Response(
      JSON.stringify({ error: "No push subscriptions found. Enable push first." }),
      { status: 400 }
    );
  }

  const payload = {
    title: "BremLogic",
    body: "Test push notification from your signal desk.",
    url: "/",
  };
  const { sent, results } = await sendPushPayload(subs, payload);
  if (sent === 0) {
    return new Response(
      JSON.stringify({ error: "Failed to send push to active subscription(s).", results }),
      { status: 500 }
    );
  }

  return new Response(JSON.stringify({ ok: true, sent, results }));
}
