const SIMULATOR_URL = "https://www.bremlogic.com/simulator";

export function EmbeddedSimulatorPanel() {
  return (
    <section className="panel simulator-panel">
      <div className="simulator-head">
        <div>
          <h1 className="title">Simulator</h1>
          <p className="subtext">
            Open the BremLogic simulator inside the same app shell used by Signals and Perps.
          </p>
        </div>
        <a
          className="secondary simulator-link-button"
          href={SIMULATOR_URL}
          target="_blank"
          rel="noreferrer"
        >
          Open in New Tab
        </a>
      </div>

      <div className="simulator-frame-shell">
        <div className="perps-message-card">
          <strong>Simulator opens separately</strong>
          <p className="subtext" style={{ marginTop: 8 }}>
            The previous embedded simulator loaded a second BremLogic app inside this dashboard, which caused script and wallet-flow conflicts.
            Open the simulator in a separate tab for now so the main app stays stable.
          </p>
          <div className="wallet-controls" style={{ marginTop: 12 }}>
            <a className="secondary simulator-link-button" href={SIMULATOR_URL} target="_blank" rel="noreferrer">
              Launch Simulator
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
