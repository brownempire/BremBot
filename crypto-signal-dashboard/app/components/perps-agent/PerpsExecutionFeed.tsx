"use client";

type ExecutionItem = {
  executionId: string;
  symbol: string;
  side: "long" | "short";
  status: string;
  mode: "paper" | "live";
  executionModel: "approval-assisted" | "delegated-ready";
  reasonMessage: string;
  createdAt: string;
  txid?: string | null;
};

export function PerpsExecutionFeed({ executions }: { executions: ExecutionItem[] }) {
  return (
    <div className="perps-agent-card">
      <div className="perps-agent-row">
        <strong>Recent Agent Executions</strong>
      </div>
      {executions.length === 0 ? (
        <div className="subtext">No per-user Perps agent executions yet.</div>
      ) : (
        <div className="perps-agent-feed">
          {executions.map((execution) => (
            <div key={execution.executionId} className="perps-agent-feed-row">
              <div>
                <strong>{execution.symbol} {execution.side === "long" ? "long" : "short"}</strong>
                <div className="subtext">{execution.reasonMessage}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div>{execution.mode === "live" ? "Live" : "Paper"} · {execution.status}</div>
                <div className="subtext">{new Date(execution.createdAt).toLocaleTimeString()}</div>
                {execution.txid ? <div className="subtext">{execution.txid.slice(0, 12)}...</div> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
