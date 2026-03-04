import { removeSubscription } from "@/lib/push/store";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const endpoint = String(body?.endpoint ?? "");
    if (!endpoint) {
      return new Response(JSON.stringify({ error: "Missing endpoint" }), { status: 400 });
    }
    const subs = await removeSubscription(endpoint);
    return new Response(JSON.stringify({ ok: true, count: subs.length }));
  } catch {
    return new Response(JSON.stringify({ error: "Failed to parse request" }), { status: 400 });
  }
}
