const SIMULATOR_URL = "/simulator?embedded=1";

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
        >
          Open Full Page
        </a>
      </div>

      <div className="simulator-frame-shell">
        <iframe
          title="BremLogic Simulator"
          src={SIMULATOR_URL}
          className="simulator-frame"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </section>
  );
}
