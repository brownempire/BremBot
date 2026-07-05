import { createPerpsApproval, getPerpsApproval, updatePerpsApproval } from "@/lib/perpsApprovalStore";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id")?.trim() ?? "";
  if (!id) {
    return Response.json({ error: "Missing approval id." }, { status: 400 });
  }

  const approval = await getPerpsApproval(id);
  if (!approval) {
    return Response.json({ error: "Approval request not found." }, { status: 404 });
  }

  return Response.json({ approval });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.walletAddress || !body?.signalId || !body?.signalSummary || !body?.symbol || !body?.request) {
    return Response.json({ error: "Incomplete approval request." }, { status: 400 });
  }

  const approval = await createPerpsApproval({
    walletAddress: String(body.walletAddress),
    signalId: String(body.signalId),
    signalSummary: String(body.signalSummary),
    symbol: String(body.symbol),
    request: body.request,
    openedTxid: null,
    failureReason: null,
  });

  return Response.json({
    approval,
    approvalUrl: `/signals-bot?approval=${encodeURIComponent(approval.id)}`,
  });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const id = String(body?.id ?? "").trim();
  if (!id) {
    return Response.json({ error: "Missing approval id." }, { status: 400 });
  }

  const approval = await updatePerpsApproval(id, {
    status: body?.status,
    openedTxid: typeof body?.openedTxid === "string" ? body.openedTxid : undefined,
    failureReason: typeof body?.failureReason === "string" ? body.failureReason : undefined,
  });

  if (!approval) {
    return Response.json({ error: "Approval request not found." }, { status: 404 });
  }

  return Response.json({ approval });
}
