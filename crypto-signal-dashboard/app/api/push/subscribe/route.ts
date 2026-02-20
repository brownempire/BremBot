import { addSubscription } from "@/lib/push/store";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body?.endpoint) {
      return new Response(JSON.stringify({ error: "Invalid subscription" }), { status: 400 });
    }
    const subs = addSubscription(body);
    return new Response(JSON.stringify({ ok: true, count: subs.length }));
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to parse subscription" }), { status: 400 });
  }
}
