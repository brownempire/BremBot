const SIMULATOR_URL = "https://www.bremlogic.com/simulator";

export function EmbeddedSimulatorPanel() {
  return (
    <div className="simulator-frame-shell simulator-frame-shell-plain">
        <iframe
          title="BremLogic Simulator"
          src={SIMULATOR_URL}
          className="simulator-frame simulator-frame-plain"
          allow="clipboard-read; clipboard-write"
        />
    </div>
  );
}
