import { listTradeDecisionRecords, readTradeDecisionJournal } from "@/lib/decision/logStore";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 30) || 30));
  const content = await readTradeDecisionJournal();
  const entries = await listTradeDecisionRecords(limit);
  return Response.json({ content, entries });
}
