import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { perpsExecutionAckSchema } from "@/lib/perps/sessionTypes";
import {
  clearUserPerpsExecutionFeed,
  listVisibleUserPerpsExecutions,
  updateUserPerpsExecution,
} from "@/lib/perps/userExecutionAudit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit") ?? 20) || 20));
  const executions = (await listVisibleUserPerpsExecutions(walletAddress)).slice(0, limit);

  return Response.json({
    walletAddress,
    executions,
  });
}

export async function DELETE(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clearedBefore = await clearUserPerpsExecutionFeed(walletAddress);
  return Response.json({ ok: true, clearedBefore });
}

export async function PATCH(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = perpsExecutionAckSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: "Invalid execution update payload.", detail: parsed.error.message }, { status: 400 });
  }

  const updated = await updateUserPerpsExecution(walletAddress, parsed.data.executionId, {
    status: parsed.data.status,
    txid: parsed.data.txid ?? null,
    errorMessage: parsed.data.errorMessage ?? null,
    positionPubkey: parsed.data.positionPubkey ?? null,
  });

  if (!updated) {
    return Response.json({ error: "Execution record not found." }, { status: 404 });
  }

  return Response.json({ ok: true, execution: updated });
}
