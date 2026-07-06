import { getAnyPushConfigError, sendNotificationPayload } from "@/lib/push/dispatch";

export async function POST(request: Request) {
  const configError = getAnyPushConfigError();
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
  const result = await sendNotificationPayload({
    title: "BremLogic",
    body: "Test push notification from your signal desk.",
    url: "/signals-bot",
    sound: typeof (body as { sound?: string } | null)?.sound === "string"
      ? (body as { sound?: string }).sound ?? undefined
      : undefined,
    subscription: body?.subscription ?? null,
    walletAddress: typeof (body as { walletAddress?: string } | null)?.walletAddress === "string"
      ? (body as { walletAddress?: string }).walletAddress ?? null
      : null,
    nativeToken: typeof (body as { nativeToken?: string } | null)?.nativeToken === "string"
      ? (body as { nativeToken?: string }).nativeToken ?? null
      : null,
  });
  if (result.sent === 0) {
    return new Response(
      JSON.stringify({ error: "Failed to send push to active subscription(s)." }),
      { status: 500 }
    );
  }

  return new Response(JSON.stringify({ ok: true, sent: result.sent, web: result.web, native: result.native }));
}
