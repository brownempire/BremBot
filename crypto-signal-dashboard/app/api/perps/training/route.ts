import { getActiveDecisionLearningProfile, listDecisionLearningProfileHistory, listTradeLearningOutcomes } from "@/lib/decision/learningStore";
import { listTradeDecisionRecords } from "@/lib/decision/logStore";
import { reconcileTradeLearningOutcomes } from "@/lib/decision/outcomeReconciler";
import { trainWalletDecisionProfile } from "@/lib/decision/trainer";
import { fetchJupiterPerpsAccountSnapshot } from "@/lib/jupiterPerps";
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
    const [config, executions, decisions] = await Promise.all([
      getPerpsAutomationConfig(walletAddress),
      listUserPerpsExecutions(walletAddress),
      listTradeDecisionRecords(2_000, walletAddress),
    ]);
    const agentWallet = getAgentWalletForOwner(walletAddress);
    let reconciledOutcomes = 0;
    if (agentWallet) {
      try {
        const snapshot = await fetchJupiterPerpsAccountSnapshot(agentWallet);
        reconciledOutcomes = (await reconcileTradeLearningOutcomes({ walletAddress, executions, decisions, snapshot })).length;
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
