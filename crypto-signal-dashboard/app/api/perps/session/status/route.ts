import { getPerpsSessionConfig } from "@/lib/perps/sessionConfig";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { perpsSessionHeartbeatSchema } from "@/lib/perps/sessionTypes";
import { getPerpsSessionWithTimeout, heartbeatPerpsSession } from "@/lib/perps/tradingAgent";
import { getPerpsDelegationCapability } from "@/lib/perps/delegationAdapter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await getPerpsSessionWithTimeout(walletAddress);
  const config = getPerpsSessionConfig();
  return Response.json({
    walletAddress,
    session,
    globalKillSwitch: config.globalKillSwitch,
    delegatedExecutionAvailable: getPerpsDelegationCapability(walletAddress).available,
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
