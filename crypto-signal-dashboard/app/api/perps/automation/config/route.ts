import { perpsAutomationConfigInputSchema } from "@/lib/perps/automationConfig";
import {
  getPerpsAutomationConfig,
  savePerpsAutomationConfig,
} from "@/lib/perps/automationConfigStore";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const config = await getPerpsAutomationConfig(walletAddress);
    return Response.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Unable to load autonomous Perps configuration.",
    }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = perpsAutomationConfigInputSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Invalid autonomous Perps configuration.", detail: parsed.error.message }, { status: 400 });
  }

  try {
    const config = await savePerpsAutomationConfig({
      walletAddress,
      settings: parsed.data.settings,
      params: parsed.data.params,
      updatedAt: new Date().toISOString(),
    });
    return Response.json({ config });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Unable to save autonomous Perps configuration.",
    }, { status: 503 });
  }
}
