import { addNativePushDevice } from "@/lib/push/nativeStore";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const token = String(body?.token ?? "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing native device token" }), { status: 400 });
    }

    const devices = await addNativePushDevice({
      token,
      walletAddress: typeof body?.walletAddress === "string" ? body.walletAddress.trim() || null : null,
      platform: "ios",
    });

    return new Response(JSON.stringify({ ok: true, count: devices.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Failed to parse native device token" }), { status: 400 });
  }
}
