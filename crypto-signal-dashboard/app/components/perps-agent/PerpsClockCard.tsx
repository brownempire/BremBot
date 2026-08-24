"use client";

type PerpsClockCardProps = {
  connectionLabel: "Disconnected" | "Connected";
  sessionStateLabel: "Clocked In" | "Clocked Out";
  modeLabel: "Paper mode" | "Live mode";
  executionModelLabel: string;
  walletControlledLabel: string;
  decisionMode: "shadow" | "active";
  unlimitedSession: boolean;
  warning: string | null;
  canClockIn: boolean;
  isBusy: boolean;
  onClockIn: () => void;
  onClockOut: () => void;
  onViewLog: () => void;
  scalpModeEnabled: boolean;
  onToggleScalpMode: (enabled: boolean) => void;
  onToggleMode: () => void;
  onToggleDecisionMode: () => void;
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
          <span>Shadow Mode</span>
          <button
            type="button"
            className={`perps-decision-mode ${props.decisionMode}`}
            onClick={props.onToggleDecisionMode}
            disabled={props.isBusy}
            aria-pressed={props.decisionMode === "active"}
          >
            {props.decisionMode === "active" ? "Active Mode" : "Shadow Mode"}
          </button>
        </div>
      </div>
      <div className="wallet-controls perps-agent-controls">
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
        <button type="button" className="secondary" onClick={props.onViewLog} disabled={props.isBusy}>
          Log
        </button>
        <details className="perps-scalp-menu">
          <summary className={`secondary ${props.scalpModeEnabled ? "is-enabled" : ""}`}>
            Scalp {props.scalpModeEnabled ? "On" : "Off"}
          </summary>
          <div className="perps-scalp-dropdown">
            <div>
              <strong>Scalp Mode</strong>
              <div className="subtext">Sideways-market strategy</div>
            </div>
            <label className="perps-scalp-switch">
              <input
                type="checkbox"
                checked={props.scalpModeEnabled}
                onChange={(event) => props.onToggleScalpMode(event.target.checked)}
                disabled={props.isBusy}
                aria-label={`Turn Scalp Mode ${props.scalpModeEnabled ? "off" : "on"}`}
              />
              <span aria-hidden="true" />
            </label>
            <div className="perps-scalp-rule">
              Profit target <strong>0.5-1.0% price move</strong>
            </div>
            <div className="perps-scalp-rule">
              Wallet allocation <strong>50%</strong>
            </div>
            <div className="perps-scalp-rule">
              Leverage <strong>25-40×</strong>
            </div>
            <div className="perps-scalp-rule">
              Exceptional cap <strong>50×</strong>
            </div>
            <div className="perps-scalp-rule">
              Stop loss <strong>15% ROE</strong>
            </div>
            <div className="subtext">Setup/ATR-aware TP · 15% ROE SL · profit-lock ladder · at least $1 net after estimated fees.</div>
            <div className="subtext">Automatically turns off when a trend or breakout signal appears.</div>
          </div>
        </details>
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
