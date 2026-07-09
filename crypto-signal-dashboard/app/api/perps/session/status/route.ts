import { getPerpsSessionConfig } from "@/lib/perps/sessionConfig";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { getPerpsSession } from "@/lib/perps/sessionStore";
import { perpsSessionHeartbeatSchema } from "@/lib/perps/sessionTypes";
import { heartbeatPerpsSession } from "@/lib/perps/tradingAgent";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await getPerpsSession(walletAddress);
  const config = getPerpsSessionConfig();
  return Response.json({
    walletAddress,
    session,
    globalKillSwitch: config.globalKillSwitch,
    delegatedExecutionAvailable: config.delegatedExecutionAvailable,
  });
}

export async function PATCH(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = perpsSessionHeartbeatSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Invalid session heartbeat payload.", detail: parsed.error.message }, { status: 400 });
  }

  const session = await heartbeatPerpsSession(walletAddress, parsed.data);
  return Response.json({ ok: true, session });
}
