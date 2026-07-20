import assert from "node:assert/strict";
import test from "node:test";

import { pdfDataUriToBase64, saveSimulatorPdf } from "../app/lib/simulatorPdfStorage";

test("native simulator PDF saving stores base64 data without invoking a browser download", async () => {
  let browserDownloads = 0;
  let savedFilename = "";
  let savedData = "";
  const status = await saveSimulatorPdf({
    dataUri: "data:application/pdf;base64,JVBERi0xLjQ=",
    filename: "results.pdf",
    runtime: "capacitor",
    webSave: () => { browserDownloads += 1; },
    saveCapacitor: async (filename, base64Data) => {
      savedFilename = filename;
      savedData = base64Data;
      return "saved natively";
    },
  });

  assert.equal(status, "saved natively");
  assert.equal(savedFilename, "results.pdf");
  assert.equal(savedData, "JVBERi0xLjQ=");
  assert.equal(browserDownloads, 0);
});

test("web simulator PDF saving retains the normal browser download", async () => {
  let browserDownloads = 0;
  const status = await saveSimulatorPdf({
    dataUri: "data:application/pdf;base64,JVBERi0xLjQ=",
    filename: "results.pdf",
    runtime: "web",
    webSave: () => { browserDownloads += 1; },
  });

  assert.equal(status, "PDF downloaded with the graph and complete results.");
  assert.equal(browserDownloads, 1);
});

test("Mac simulator PDF saving uses the native save dialog bridge", async () => {
  let browserDownloads = 0;
  let savedData = "";
  const status = await saveSimulatorPdf({
    dataUri: "data:application/pdf;base64,JVBERi0xLjQ=",
    filename: "results.pdf",
    runtime: "mac",
    webSave: () => { browserDownloads += 1; },
    saveMac: async (_filename, base64Data) => {
      savedData = base64Data;
      return "saved on Mac";
    },
  });

  assert.equal(status, "saved on Mac");
  assert.equal(savedData, "JVBERi0xLjQ=");
  assert.equal(browserDownloads, 0);
});

test("PDF data URI validation rejects malformed output", () => {
  assert.throws(() => pdfDataUriToBase64("not-a-pdf"), /invalid/i);
});
