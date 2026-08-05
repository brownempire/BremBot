import { getActiveDecisionLearningProfile, listDecisionLearningProfileHistory, listTradeLearningOutcomes } from "@/lib/decision/learningStore";
import { listTradeDecisionRecords } from "@/lib/decision/logStore";
import { reconcileTradeLearningOutcomes } from "@/lib/decision/outcomeReconciler";
import { resetWalletScalpToProfitableProfile, trainWalletDecisionProfile } from "@/lib/decision/trainer";
import { fetchJupiterPerpsAccountSnapshot, fetchJupiterPerpsTradeHistory } from "@/lib/jupiterPerps";
import { getPerpsAutomationConfig } from "@/lib/perps/automationConfigStore";
import { getAgentWalletForOwner } from "@/lib/perps/agentWallet";
import { getAuthorizedWalletAddress } from "@/lib/perps/sessionAuth";
import { listUserPerpsExecutions } from "@/lib/perps/userExecutionAudit";

export const dynamic = "force-dynamic";
export const maxDuration = 55;

export async function GET(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const [profile, history, outcomes] = await Promise.all([
    getActiveDecisionLearningProfile(walletAddress),
    listDecisionLearningProfileHistory(walletAddress),
    listTradeLearningOutcomes(walletAddress),
  ]);
  return Response.json({ profile, versions: history.length, outcomeCount: outcomes.length }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const walletAddress = await getAuthorizedWalletAddress(request);
  if (!walletAddress) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => null) as { action?: string } | null;
    if (body?.action === "reset-profitable-scalp") {
      const result = await resetWalletScalpToProfitableProfile({
        walletAddress,
        source: "manual-training",
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    const [config, executions, decisions] = await Promise.all([
      getPerpsAutomationConfig(walletAddress),
      listUserPerpsExecutions(walletAddress),
      listTradeDecisionRecords(2_000, walletAddress),
    ]);
    const agentWallet = getAgentWalletForOwner(walletAddress);
    let reconciledOutcomes = 0;
    if (agentWallet) {
      try {
        const [snapshot, history] = await Promise.all([
          fetchJupiterPerpsAccountSnapshot(agentWallet, { includeRecentTrades: false }),
          fetchJupiterPerpsTradeHistory(agentWallet),
        ]);
        if (!history.complete) {
          throw new Error(`Jupiter returned only ${history.trades.length} of ${history.totalCount} trades; training history was not replaced.`);
        }
        reconciledOutcomes = (await reconcileTradeLearningOutcomes({
          walletAddress,
          executions,
          decisions,
          snapshot: { ...snapshot, recentTrades: history.trades },
          replaceWalletHistory: true,
        })).length;
      } catch {
        // A temporary Jupiter history failure must not prevent training from durable outcomes already in Redis.
      }
    }
    const result = await trainWalletDecisionProfile({
      walletAddress,
      config,
      source: "manual-training",
      force: true,
    });
    return Response.json({ ...result, reconciledOutcomes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Unable to train the wallet-specific Perps agent.",
    }, { status: 503 });
  }
}
