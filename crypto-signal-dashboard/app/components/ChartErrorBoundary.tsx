"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean; retryKey: number };

export class ChartErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, retryKey: 0 };
  private retryTimer: number | null = null;

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    if (this.state.retryKey >= 2 || typeof window === "undefined") return;
    this.retryTimer = window.setTimeout(() => {
      this.setState((current) => ({ failed: false, retryKey: current.retryKey + 1 }));
    }, 250);
  }

  componentWillUnmount() {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="tradingview-frame">
          <div className="tradingview-loading" role="status" aria-label="Reconnecting TradingView chart">
            <span className="tradingview-loading-spinner" aria-hidden="true" />
            <span>Reconnecting chart…</span>
          </div>
        </div>
      );
    }
    return <div key={this.state.retryKey} className="tradingview-chart-boundary">{this.props.children}</div>;
  }
}
