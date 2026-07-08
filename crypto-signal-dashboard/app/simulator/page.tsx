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
    <main className={`simulator-page ${embedded ? "simulator-page-embedded" : ""}`}>
      <div className="simulator-frame-shell simulator-frame-shell-plain">
        <iframe
          title="BremLogic Full Simulator"
          src="https://www.bremlogic.com/simulator"
          className="simulator-frame simulator-frame-plain"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </main>
  );
}
