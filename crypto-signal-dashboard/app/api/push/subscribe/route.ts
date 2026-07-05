import { addSubscription } from "@/lib/push/store";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.endpoint) {
      return new Response(JSON.stringify({ error: "Invalid subscription" }), { status: 400 });
    }
    const subs = await addSubscription({
      ...body,
      walletAddress: typeof body.walletAddress === "string" ? body.walletAddress.trim() || null : null,
      nativeShell: Boolean(body.nativeShell),
      platform: body.platform === "native" ? "native" : "web",
    });
    return new Response(JSON.stringify({ ok: true, count: subs.length }));
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to parse subscription" }), { status: 400 });
  }
}
