import { getAnyPushConfigError, sendNotificationPayload } from "@/lib/push/dispatch";

export async function POST(request: Request) {
  const configError = getAnyPushConfigError();
  if (configError) {
    return new Response(
      JSON.stringify({ error: configError }),
      { status: 400 }
    );
  }
  const body = await request.json();

  const payload = {
    title: body?.title ?? "BremLogic",
    body: body?.body ?? "A new signal was triggered.",
    url: body?.url ?? "/",
    sound: typeof body?.sound === "string" ? body.sound : undefined,
  };

  const result = await sendNotificationPayload({
    title: payload.title,
    body: payload.body,
    url: payload.url,
    sound: payload.sound,
    subscription: body?.subscription ?? null,
    walletAddress: typeof body?.walletAddress === "string" ? body.walletAddress : null,
    nativeToken: typeof body?.nativeToken === "string" ? body.nativeToken : null,
  });
  if (result.sent === 0) {
    return new Response(JSON.stringify({ error: "No push subscriptions found. Enable push first." }), {
      status: 400,
    });
  }

  return new Response(JSON.stringify({ ok: true, sent: result.sent, web: result.web, native: result.native }));
}
