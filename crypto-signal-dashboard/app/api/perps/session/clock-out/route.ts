import { clockOutPerpsSession } from "@/lib/perps/tradingAgent";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null) as { reason?: string } | null;
  const session = await clockOutPerpsSession(walletAddress, payload?.reason);
  return Response.json({ ok: true, session });
}
