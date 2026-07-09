"use client";

type PerpsClockCardProps = {
  connectionLabel: "Disconnected" | "Connected";
  sessionStateLabel: "Clocked In" | "Clocked Out";
  modeLabel: "Paper mode" | "Live mode";
  executionModelLabel: string;
  walletControlledLabel: string;
  killSwitchOn: boolean;
  unlimitedSession: boolean;
  warning: string | null;
  canClockIn: boolean;
  isBusy: boolean;
  onClockIn: () => void;
  onClockOut: () => void;
  onToggleMode: () => void;
  onToggleUnlimited: (enabled: boolean) => void;
};

export function PerpsClockCard(props: PerpsClockCardProps) {
  return (
    <div className="perps-agent-card">
      <div className="perps-agent-row">
        <strong>Perps Trading Agent</strong>
        <span className={`perps-agent-pill ${props.modeLabel === "Live mode" ? "live" : "paper"}`}>{props.modeLabel}</span>
      </div>
      <div className="subtext">{props.walletControlledLabel}</div>
      <div className="perps-agent-grid">
        <div className="perps-agent-stat">
          <span>Wallet</span>
          <strong>{props.connectionLabel}</strong>
        </div>
        <div className="perps-agent-stat">
          <span>Session</span>
          <strong>{props.sessionStateLabel}</strong>
        </div>
        <div className="perps-agent-stat">
          <span>Execution</span>
          <strong>{props.executionModelLabel}</strong>
        </div>
        <div className="perps-agent-stat">
          <span>Kill switch</span>
          <strong>{props.killSwitchOn ? "On" : "Off"}</strong>
        </div>
      </div>
      <div className="wallet-controls">
        <button type="button" className={props.modeLabel === "Paper mode" ? "" : "secondary"} onClick={props.onToggleMode} disabled={props.isBusy}>
          {props.modeLabel === "Paper mode" ? "Switch To Live" : "Switch To Paper"}
        </button>
        {props.sessionStateLabel === "Clocked In" ? (
          <button type="button" className="secondary" onClick={props.onClockOut} disabled={props.isBusy}>
            {props.isBusy ? "Stopping..." : "Clock Out"}
          </button>
        ) : (
          <button type="button" onClick={props.onClockIn} disabled={!props.canClockIn || props.isBusy}>
            {props.isBusy ? "Starting..." : "Clock In"}
          </button>
        )}
      </div>
      <label className="auto-trade-checkbox-row">
        <input
          type="checkbox"
          checked={props.unlimitedSession}
          onChange={(event) => props.onToggleUnlimited(event.target.checked)}
        />
        <span>Unlimited session while app stays open</span>
      </label>
      {props.warning ? <div className="perps-agent-warning">{props.warning}</div> : null}
    </div>
  );
}
