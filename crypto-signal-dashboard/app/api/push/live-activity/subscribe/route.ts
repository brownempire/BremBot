import {
  addLiveActivityPushToken,
  isValidLiveActivityPositionKey,
  isValidLiveActivityToken,
} from "@/lib/push/liveActivityStore";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const token = String(body?.token ?? "").trim().toLowerCase();
    const positionKey = String(body?.positionKey ?? "").trim().toUpperCase();

    if (!isValidLiveActivityToken(token) || !isValidLiveActivityPositionKey(positionKey)) {
      return Response.json({ error: "Invalid Live Activity registration" }, { status: 400 });
    }

    await addLiveActivityPushToken({ token, positionKey });
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live Activity registration failed";
    const status = message.includes("Redis") ? 503 : 400;
    return Response.json({ error: message }, { status });
  }
}
