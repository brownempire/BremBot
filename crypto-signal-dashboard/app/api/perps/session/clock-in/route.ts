import { isPerpsLiveWalletAllowed } from "@/lib/perps/sessionConfig";
import { clockInPerpsSession } from "@/lib/perps/tradingAgent";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { perpsClockInSchema } from "@/lib/perps/sessionTypes";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = perpsClockInSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Invalid clock-in payload.", detail: parsed.error.message }, { status: 400 });
  }

  if (parsed.data.mode === "live" && parsed.data.platform !== "native") {
    return Response.json({
      error: "Live perps automation currently requires the native Jupiter Mobile wallet session path. Web/PWA remains delegated-ready only for now.",
    }, { status: 409 });
  }

  if (parsed.data.mode === "live" && !isPerpsLiveWalletAllowed(walletAddress)) {
    return Response.json({
      error: "Live Perps automation is not enabled for this wallet. Paper mode, spot auto-trade, and manual Perps remain available.",
    }, { status: 403 });
  }

  const session = await clockInPerpsSession(walletAddress, parsed.data);
  return Response.json({ ok: true, session });
}
