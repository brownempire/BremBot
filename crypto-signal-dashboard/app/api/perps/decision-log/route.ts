import { listTradeDecisionRecords, readTradeDecisionJournal } from "@/lib/decision/logStore";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { listUserPerpsExecutions } from "@/lib/perps/userExecutionAudit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 30) || 30));
  const [content, entries, executions] = await Promise.all([
    readTradeDecisionJournal(walletAddress),
    listTradeDecisionRecords(limit, walletAddress),
    listUserPerpsExecutions(walletAddress),
  ]);
  return Response.json({ content, entries, executions: executions.slice(0, limit) });
}
