import { runPerpsTradeNotificationWatch } from "@/lib/perps/tradeNotifications";

export const dynamic = "force-dynamic";

function validateCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return true;
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return token === secret;
}

export async function GET(request: Request) {
  if (!validateCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runPerpsTradeNotificationWatch();
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
