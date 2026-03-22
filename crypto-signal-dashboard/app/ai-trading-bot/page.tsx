const officeUrl = process.env.CLAW3D_OFFICE_URL?.trim() ?? "";
const officeHost = officeUrl ? new URL(officeUrl).host : "tailnet office URL not configured";

const agents = [
  {
    name: "ClawMir",
    role: "CEO / orchestrator",
    note: "Runs the room, assigns missions, and synthesizes final decisions.",
  },
  {
    name: "Vector",
    role: "reconnaissance",
    note: "Maps competitors, facts, sources, and market terrain.",
  },
  {
    name: "Delta",
    role: "signal analyst",
    note: "Reads momentum, regime shifts, timing, and narrative change.",
  },
  {
    name: "Anvil",
    role: "strategy forge",
    note: "Turns research and signals into plans, offers, and action.",
  },
  {
    name: "Aegis",
    role: "defensive review",
    note: "Pressure-tests logic, evidence, and risk before execution.",
  },
  {
    name: "Beacon",
    role: "monitoring",
    note: "Tracks deltas, watchlists, and recurring changes over time.",
  },
];

const quickActions = [
  "Open Office",
  "Run market brief",
  "Review active signals",
  "Summon war room agents",
];

export default function AiTradingBotPage() {
  return (
    <main className="war-room-page">
      <header className="war-room-header panel">
        <div>
          <div className="war-room-kicker">BremLogic / AI Trading Bot</div>
          <h1 className="title">ClawMir War Room</h1>
          <p className="subtext war-room-intro">
            Your operator surface for ClawMir, the office view, and the specialized agents that will
            run research, signal analysis, strategy, review, and monitoring.
          </p>
        </div>
        <div className="war-room-header-actions">
          {officeUrl ? (
            <>
              <a className="war-room-link-button" href={officeUrl} target="_blank" rel="noreferrer">
                Open Office in New Tab
              </a>
              <div className="war-room-badge">Tailnet target: {officeHost}</div>
            </>
          ) : (
            <div className="war-room-warning">
              Set <code>CLAW3D_OFFICE_URL</code> to your tailnet-accessible Claw3D office URL to
              enable embed + launch.
            </div>
          )}
        </div>
      </header>

      <section className="war-room-grid">
        <section className="panel war-room-sidebar">
          <div className="war-room-section-head">
            <h2>Mission Control</h2>
            <span className="subtext">Fast actions for the room</span>
          </div>

          <div className="war-room-actions">
            {quickActions.map((action) => (
              <button key={action} type="button" className="secondary" disabled={!officeUrl && action === "Open Office"}>
                {action}
              </button>
            ))}
          </div>

          <div className="war-room-section-head">
            <h2>Agent Roster</h2>
            <span className="subtext">Cold trader + war-room stack</span>
          </div>

          <div className="war-room-agent-list">
            {agents.map((agent) => (
              <article key={agent.name} className="war-room-agent-card">
                <div className="war-room-agent-top">
                  <strong>{agent.name}</strong>
                  <span>{agent.role}</span>
                </div>
                <p>{agent.note}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel war-room-main">
          <div className="war-room-section-head war-room-main-head">
            <div>
              <h2>Office View</h2>
              <span className="subtext">
                Embedded Claw3D office over tailnet. If embedding is blocked on a given device,
                launch it in a new tab.
              </span>
            </div>
            {officeUrl ? (
              <a className="war-room-link-button secondary-link" href={officeUrl} target="_blank" rel="noreferrer">
                Launch Office
              </a>
            ) : null}
          </div>

          {officeUrl ? (
            <div className="war-room-office-shell">
              <iframe
                title="Claw3D Office"
                src={officeUrl}
                className="war-room-office-frame"
                allow="clipboard-read; clipboard-write"
              />
            </div>
          ) : (
            <div className="war-room-empty-state">
              <h3>Office embed not configured yet</h3>
              <p>
                Once you expose Claw3D on your tailnet, set <code>CLAW3D_OFFICE_URL</code> to
                something like <code>https://your-tailnet-host/office</code> and this tab will load
                it directly.
              </p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
