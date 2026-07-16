import { isPerpsLiveWalletAllowed } from "@/lib/perps/sessionConfig";
import { clockInPerpsSession } from "@/lib/perps/tradingAgent";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { perpsClockInSchema } from "@/lib/perps/sessionTypes";
import { getPerpsDelegationCapability } from "@/lib/perps/delegationAdapter";

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

  const delegation = getPerpsDelegationCapability(walletAddress);
  if (parsed.data.mode === "live" && parsed.data.platform !== "native" && !delegation.available) {
    return Response.json({
      error: "Live Perps automation requires either the native Jupiter Mobile approval path or a configured agent wallet.",
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
