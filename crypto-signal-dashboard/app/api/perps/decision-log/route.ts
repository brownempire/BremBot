import { readTradeDecisionJournal } from "@/lib/decision/logStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const content = await readTradeDecisionJournal();
  return Response.json({ content });
}
