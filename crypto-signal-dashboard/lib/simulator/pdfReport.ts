import { jsPDF } from "jspdf";

export type SimulatorPdfField = {
  label: string;
  value: string;
};

export type SimulatorPdfTradeRow = {
  trade: string;
  result: string;
  start: string;
  margin: string;
  position: string;
  grossPnl: string;
  fees: string;
  netPnl: string;
  end: string;
};

export type SimulatorPdfReport = {
  modeLabel: string;
  generatedAt: string;
  logoDataUrl: string;
  chartDataUrl: string;
  chartNote: string;
  summary: SimulatorPdfField[];
  inputs: SimulatorPdfField[];
  trades: SimulatorPdfTradeRow[];
  logTitle: string;
  logNote: string;
};

const PAGE_WIDTH = 297;
const PAGE_HEIGHT = 210;
const PAGE_MARGIN = 14;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

function addPageHeader(doc: jsPDF, report: SimulatorPdfReport, section: string) {
  doc.setFillColor(8, 13, 24);
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, "F");
  doc.addImage(report.logoDataUrl, "PNG", PAGE_MARGIN, 8, 46, 15);
  doc.setTextColor(240, 244, 252);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(section, PAGE_MARGIN + 52, 15);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(160, 172, 194);
  doc.text(`${report.modeLabel} | Generated ${report.generatedAt}`, PAGE_MARGIN + 52, 21);
  doc.setDrawColor(43, 55, 77);
  doc.line(PAGE_MARGIN, 27, PAGE_WIDTH - PAGE_MARGIN, 27);
}

function addFooter(doc: jsPDF, page: number, pages: number) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(125, 139, 165);
  doc.text("BremLogic Jupiter Perps Simulator", PAGE_MARGIN, PAGE_HEIGHT - 6);
  doc.text(`Page ${page} of ${pages}`, PAGE_WIDTH - PAGE_MARGIN, PAGE_HEIGHT - 6, { align: "right" });
}

function addFieldGrid(doc: jsPDF, fields: SimulatorPdfField[], startY: number, columns = 3) {
  const gap = 5;
  const cellWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const cellHeight = 17;
  fields.forEach((field, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = PAGE_MARGIN + column * (cellWidth + gap);
    const y = startY + row * (cellHeight + 4);
    doc.setFillColor(16, 24, 39);
    doc.setDrawColor(42, 55, 78);
    doc.roundedRect(x, y, cellWidth, cellHeight, 2, 2, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(139, 153, 178);
    doc.text(field.label.toUpperCase(), x + 4, y + 6);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(239, 244, 252);
    doc.text(field.value, x + 4, y + 13, { maxWidth: cellWidth - 8 });
  });
}

function addTradeTablePage(
  doc: jsPDF,
  report: SimulatorPdfReport,
  rows: SimulatorPdfTradeRow[],
  startIndex: number
) {
  addPageHeader(doc, report, report.logTitle);
  const headers = ["Trade", "Result", "Start", "Margin", "Position", "Gross PnL", "Fees", "Net PnL", "End"];
  const keys: Array<keyof SimulatorPdfTradeRow> = ["trade", "result", "start", "margin", "position", "grossPnl", "fees", "netPnl", "end"];
  const widths = [12, 18, 33, 33, 36, 34, 30, 34, 33];
  let y = 34;
  let x = PAGE_MARGIN;
  doc.setFillColor(27, 39, 59);
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 8, "F");
  headers.forEach((header, index) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.setTextColor(210, 220, 237);
    doc.text(header, x + 2, y + 5.3);
    x += widths[index]!;
  });
  y += 8;

  rows.forEach((row, rowIndex) => {
    x = PAGE_MARGIN;
    doc.setFillColor(rowIndex % 2 === 0 ? 13 : 17, rowIndex % 2 === 0 ? 20 : 25, rowIndex % 2 === 0 ? 33 : 40);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 6.4, "F");
    keys.forEach((key, index) => {
      doc.setFont("helvetica", key === "result" ? "bold" : "normal");
      doc.setFontSize(6.2);
      const value = row[key];
      if (key === "result") {
        if (value === "WIN") doc.setTextColor(86, 220, 159);
        else doc.setTextColor(255, 118, 129);
      } else {
        doc.setTextColor(218, 225, 237);
      }
      doc.text(value, x + 2, y + 4.4, { maxWidth: widths[index]! - 3 });
      x += widths[index]!;
    });
    y += 6.4;
  });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(139, 153, 178);
  doc.text(`${report.logNote} Rows ${startIndex + 1}-${startIndex + rows.length} of ${report.trades.length}.`, PAGE_MARGIN, PAGE_HEIGHT - 12);
}

export function buildSimulatorReportPdf(report: SimulatorPdfReport) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  addPageHeader(doc, report, "Simulator Results");

  const summaryColumns = Math.min(4, Math.max(1, report.summary.length));
  addFieldGrid(doc, report.summary, 33, summaryColumns);
  const summaryBottom = 33 + (Math.ceil(report.summary.length / summaryColumns) - 1) * 21 + 17;
  const chartTitleY = summaryBottom + 9;
  const chartBoxY = chartTitleY + 4;
  const chartBoxHeight = 184 - chartBoxY;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(210, 220, 237);
  doc.text("EQUITY GRAPH", PAGE_MARGIN, chartTitleY);
  doc.setFillColor(10, 15, 25);
  doc.setDrawColor(42, 55, 78);
  doc.roundedRect(PAGE_MARGIN, chartBoxY, CONTENT_WIDTH, chartBoxHeight, 2, 2, "FD");
  const chartProperties = doc.getImageProperties(report.chartDataUrl);
  const chartAvailableWidth = CONTENT_WIDTH - 10;
  const chartAvailableHeight = chartBoxHeight - 17;
  const chartScale = Math.min(
    chartAvailableWidth / chartProperties.width,
    chartAvailableHeight / chartProperties.height
  );
  const chartWidth = chartProperties.width * chartScale;
  const chartHeight = chartProperties.height * chartScale;
  const chartX = PAGE_MARGIN + (CONTENT_WIDTH - chartWidth) / 2;
  const chartY = chartBoxY + 4 + (chartAvailableHeight - chartHeight) / 2;
  doc.addImage(report.chartDataUrl, "PNG", chartX, chartY, chartWidth, chartHeight, undefined, "FAST");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(139, 153, 178);
  const chartLines = doc.splitTextToSize(report.chartNote, CONTENT_WIDTH - 10) as string[];
  doc.text(chartLines.slice(0, 2), PAGE_MARGIN + 5, chartBoxY + chartBoxHeight - 5);

  doc.addPage("a4", "landscape");
  addPageHeader(doc, report, "Simulator Inputs");
  addFieldGrid(doc, report.inputs, 34);

  const rowsPerPage = 23;
  if (report.trades.length === 0) {
    doc.addPage("a4", "landscape");
    addPageHeader(doc, report, report.logTitle);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(180, 192, 213);
    doc.text("No calculated trade rows are available for this result.", PAGE_MARGIN, 42);
  } else {
    for (let startIndex = 0; startIndex < report.trades.length; startIndex += rowsPerPage) {
      doc.addPage("a4", "landscape");
      addTradeTablePage(doc, report, report.trades.slice(startIndex, startIndex + rowsPerPage), startIndex);
    }
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    addFooter(doc, page, pages);
  }
  return doc;
}
