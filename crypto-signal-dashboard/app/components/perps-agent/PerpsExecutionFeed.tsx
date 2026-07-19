"use client";

import { useLayoutEffect, useRef, useState } from "react";

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

type PerpsExecutionFeedProps = {
  executions: ExecutionItem[];
  onClear: () => Promise<void>;
};

const VISIBLE_EXECUTION_COUNT = 5;

function executionStatusLabel(status: string) {
  if (status === "submitted") return "Taken · Submitted";
  if (status === "confirmed") return "Taken · Confirmed";
  if (status === "closed") return "Taken · Closed";
  if (status === "paper_executed") return "Taken · Paper";
  if (status === "blocked") return "Skipped";
  if (status === "approval_required") return "Awaiting approval";
  return status.replace(/_/g, " ");
}

export function PerpsExecutionFeed({ executions, onClear }: PerpsExecutionFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [feedMaxHeight, setFeedMaxHeight] = useState<number | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || executions.length <= VISIBLE_EXECUTION_COUNT) {
      setFeedMaxHeight(null);
      return;
    }

    const measure = () => {
      const visibleRows = executions
        .slice(0, VISIBLE_EXECUTION_COUNT)
        .map((execution) => rowRefs.current.get(execution.executionId))
        .filter((row): row is HTMLDivElement => Boolean(row));
      if (visibleRows.length !== VISIBLE_EXECUTION_COUNT) return;
      const gap = Number.parseFloat(window.getComputedStyle(feed).rowGap || "0") || 0;
      setFeedMaxHeight(visibleRows.reduce((height, row) => height + row.offsetHeight, 0) + gap * (visibleRows.length - 1));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(feed);
    executions.slice(0, VISIBLE_EXECUTION_COUNT).forEach((execution) => {
      const row = rowRefs.current.get(execution.executionId);
      if (row) observer.observe(row);
    });
    return () => observer.disconnect();
  }, [executions]);

  const clear = async () => {
    setIsClearing(true);
    setClearError(null);
    try {
      await onClear();
    } catch (error) {
      setClearError(error instanceof Error ? error.message : "Unable to clear recent agent executions.");
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="perps-agent-card">
      <div className="perps-agent-row">
        <strong>Recent Agent Executions</strong>
        <button type="button" className="secondary perps-agent-clear-button" onClick={() => { void clear(); }} disabled={executions.length === 0 || isClearing}>
          {isClearing ? "Clearing..." : "Clear"}
        </button>
      </div>
      {clearError ? <div className="perps-agent-feed-error">{clearError}</div> : null}
      {executions.length === 0 ? (
        <div className="subtext">No per-user Perps agent executions yet.</div>
      ) : (
        <div
          ref={feedRef}
          className={`perps-agent-feed${executions.length > VISIBLE_EXECUTION_COUNT ? " is-scrollable" : ""}`}
          style={feedMaxHeight === null ? undefined : { maxHeight: feedMaxHeight }}
        >
          {executions.map((execution) => (
            <div
              key={execution.executionId}
              ref={(row) => {
                if (row) rowRefs.current.set(execution.executionId, row);
                else rowRefs.current.delete(execution.executionId);
              }}
              className="perps-agent-feed-row"
            >
              <div>
                <strong>{execution.symbol} {execution.side === "long" ? "long" : "short"}</strong>
                <div className="subtext">{execution.reasonMessage}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div>{execution.mode === "live" ? "Live" : "Paper"} · {executionStatusLabel(execution.status)}</div>
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
