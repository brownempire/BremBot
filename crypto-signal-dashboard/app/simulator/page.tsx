type SimulatorPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getParamValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function SimulatorPage({ searchParams }: SimulatorPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const embedded = getParamValue(resolvedSearchParams.embedded) === "1";

  return (
    <main className="simulator-page">
      {embedded ? null : (
        <section className="panel simulator-panel" style={{ marginBottom: 18 }}>
          <div className="simulator-head">
            <div>
              <h1 className="title">Simulator</h1>
              <p className="subtext">
                Full simulator page embedded within the BremLogic app shell.
              </p>
            </div>
          </div>
        </section>
      )}
      <div className="simulator-frame-shell">
        <iframe
          title="BremLogic Full Simulator"
          src="https://www.bremlogic.com/simulator"
          className="simulator-frame"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </main>
  );
}
