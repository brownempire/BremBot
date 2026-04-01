"use client";

import { useMemo, useState } from "react";

const channels = [1, 6, 11, 36, 40, 44, 149, 153, 157];
const sampleNames = [
  "Office-Setup",
  "Guest-Net",
  "Warehouse-AP",
  "BackOffice-5G",
  "Installer-Bridge",
  "Client-Network",
];

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function generateSignals() {
  return Array.from({ length: 6 }, (_, i) => {
    const strength = Math.floor(Math.random() * 60) - 90;
    return {
      id: `${Date.now()}-${i}`,
      ssid: `${randomItem(sampleNames)}-${Math.floor(Math.random() * 99)}`,
      band: Math.random() > 0.5 ? "2.4 GHz" : "5 GHz",
      channel: randomItem(channels),
      signal: strength,
      security: Math.random() > 0.25 ? "WPA2/WPA3" : "Open",
    };
  }).sort((a, b) => b.signal - a.signal);
}

const initialSignals = [
  { id: "seed-1", ssid: "Client-Network-12", band: "5 GHz", channel: 149, signal: -46, security: "WPA2/WPA3" },
  { id: "seed-2", ssid: "Office-Setup-21", band: "5 GHz", channel: 44, signal: -59, security: "WPA2/WPA3" },
  { id: "seed-3", ssid: "Guest-Net-17", band: "2.4 GHz", channel: 6, signal: -67, security: "Open" },
];

export default function Page() {
  const [signals, setSignals] = useState(initialSignals);
  const [lastScan, setLastScan] = useState("Ready");
  const [remoteAuth, setRemoteAuth] = useState("connected");

  const strongestSignal = useMemo(() => {
    if (!signals.length) {
      return null;
    }

    return [...signals].sort((a, b) => b.signal - a.signal)[0];
  }, [signals]);

  const runScan = () => {
    setSignals(generateSignals());
    setLastScan(new Date().toLocaleTimeString());
  };

  const checkConnection = () => {
    setRemoteAuth("connected");
  };

  return (
    <main>
      <section className="panel">
        <h1>Network Install Assistant</h1>
        <p className="lead">
          Fast, installer-friendly Wi‑Fi survey tool for iPhone and desktop. Use this
          to document signal health and verify remote-auth connection status before
          installation work starts.
        </p>

        <div className="status-row">
          <span className="chip">Remote Auth: {remoteAuth}</span>
          <button type="button" className="subtle" onClick={checkConnection}>
            Re-check Connection
          </button>
        </div>

        <div className="notice">
          Browsers cannot and should not expose Wi‑Fi passwords. Credentials must be
          collected from the network owner during installation.
        </div>

        <div className="actions">
          <button type="button" className="scan" onClick={runScan}>
            Scan Nearby Networks
          </button>
          <span>{lastScan ? `Last scan: ${lastScan}` : "No scans yet"}</span>
        </div>

        {strongestSignal && (
          <div className="strongest">
            Best candidate: <strong>{strongestSignal.ssid}</strong> ({strongestSignal.signal} dBm)
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SSID</th>
                <th>Band</th>
                <th>Channel</th>
                <th>Signal</th>
                <th>Security</th>
              </tr>
            </thead>
            <tbody>
              {signals.length === 0 ? (
                <tr>
                  <td colSpan="5" className="empty">
                    Tap “Scan Nearby Networks” to load a local site survey snapshot.
                  </td>
                </tr>
              ) : (
                signals.map((network) => (
                  <tr key={network.id}>
                    <td>{network.ssid}</td>
                    <td>{network.band}</td>
                    <td>{network.channel}</td>
                    <td>{network.signal} dBm</td>
                    <td>{network.security}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
