import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { perpsAgentSignalSchema } from "@/lib/perps/sessionTypes";
import { routePerpsSignalForUser } from "@/lib/perps/tradingAgent";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = perpsAgentSignalSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Invalid perps agent payload.", detail: parsed.error.message }, { status: 400 });
  }

  const result = await routePerpsSignalForUser(walletAddress, parsed.data);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
