import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildSimulatorReportPdf, type SimulatorPdfReport } from "../lib/simulator/pdfReport";

const logoDataUrl = `data:image/png;base64,${fs.readFileSync(new URL("../public/bremlogic-logo.png", import.meta.url)).toString("base64")}`;

function createReport(modeLabel: "Simple Mode" | "Monte Carlo Mode"): SimulatorPdfReport {
  return {
    modeLabel,
    generatedAt: "7/20/2026, 12:00:00 PM",
    logoDataUrl,
    chartDataUrl: logoDataUrl,
    chartNote: "The graph contains the calculated equity paths and target balance.",
    summary: modeLabel === "Simple Mode"
      ? [
          { label: "Final Balance", value: "$125.00" },
          { label: "Total Profit", value: "$25.00" },
          { label: "Trades to Target", value: "10" },
          { label: "Target Hit?", value: "Yes" },
        ]
      : [
          { label: "Target Hit Rate", value: "72.0%" },
          { label: "Risk of Ruin", value: "3.0%" },
          { label: "Median Final Balance", value: "$118.00" },
          { label: "Avg Trades to Target", value: "14" },
        ],
    inputs: [
      { label: "Starting Balance", value: "$100.00" },
      { label: "Leverage", value: "10x" },
      { label: "Number of Trades", value: "25" },
      ...(modeLabel === "Monte Carlo Mode" ? [{ label: "Monte Carlo Runs", value: "1000" }] : []),
    ],
    trades: Array.from({ length: 25 }, (_, index) => ({
      trade: String(index + 1),
      result: index % 3 === 0 ? "LOSS" : "WIN",
      start: "$100.00",
      margin: "$80.00",
      position: "$800.00",
      grossPnl: "$12.00",
      fees: "$1.00",
      netPnl: "$11.00",
      end: "$111.00",
    })),
    logTitle: modeLabel === "Simple Mode" ? "Trade Log" : "Sample Monte Carlo Trade Log",
    logNote: "Complete calculated sample trade data.",
  };
}

for (const mode of ["Simple Mode", "Monte Carlo Mode"] as const) {
  test(`${mode} builds a branded multi-page PDF with graph and calculated data`, () => {
    const pdf = buildSimulatorReportPdf(createReport(mode));
    const bytes = new Uint8Array(pdf.output("arraybuffer"));
    const signature = new TextDecoder().decode(bytes.slice(0, 5));

    assert.equal(signature, "%PDF-");
    assert.ok(bytes.length > 50_000);
    assert.equal(pdf.getNumberOfPages(), 4);
  });
}
