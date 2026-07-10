"use client";

import { shortenWalletAddress } from "@/lib/jupiterPerps";

type PerpsSessionStatusProps = {
  walletAddress: string | null;
  platformLabel: string;
  providerLabel: string;
  appOpen: boolean;
  appForeground: boolean;
  walletWriteEnabled: boolean;
  note: string;
};

export function PerpsSessionStatus(props: PerpsSessionStatusProps) {
  return (
    <div className="perps-agent-card">
      <div className="perps-agent-row">
        <strong>Session Status</strong>
        <span className="perps-agent-pill neutral">{props.platformLabel}</span>
      </div>
      <div className="perps-agent-grid">
        <div className="perps-agent-stat">
          <span>Wallet</span>
          <strong>{props.walletAddress ? shortenWalletAddress(props.walletAddress) : "Not signed in"}</strong>
        </div>
        <div className="perps-agent-stat">
          <span>Provider</span>
          <strong>{props.providerLabel}</strong>
        </div>
        <div className="perps-agent-stat">
          <span>App open</span>
          <strong>{props.appOpen ? "Yes" : "No"}</strong>
        </div>
        <div className="perps-agent-stat">
          <span>Foreground</span>
          <strong>{props.appForeground ? "Yes" : "No"}</strong>
        </div>
        <div className="perps-agent-stat">
          <span>Wallet write</span>
          <strong>{props.walletWriteEnabled ? "Available" : "Unavailable"}</strong>
        </div>
      </div>
      <div className="subtext">{props.note}</div>
    </div>
  );
}
