export default function Page() {
  return (
    <main className="homepage">
      <section className="card hero-card">
        <img className="hero-logo" src="/header-photo.png" alt="BremLogic" />
        <h1>AI-Powered Crypto Trading Dashboard</h1>
        <p className="lead">
          Track market momentum, monitor live signals, and execute strategy like a true professional
          from the app dashboard.
        </p>
        <a className="cta" href="https://app.bremlogic.com">
          Open App
        </a>
      </section>

      <section className="card tool-card" aria-labelledby="tools-heading">
        <h2 id="tools-heading">Choose a tool to continue</h2>
        <p className="lead">
          Test leveraged perps strategies and explore potential outcomes before putting capital at
          risk.
        </p>
        <a className="cta" href="/simulator">
          Simulator
        </a>
      </section>
    </main>
  );
}
