import { Capacitor } from "@capacitor/core";

import { isNativeMacRuntime } from "@/app/lib/nativeShell";

export type SimulatorPdfRuntime = "capacitor" | "mac" | "web";

type SaveSimulatorPdfOptions = {
  dataUri: string;
  filename: string;
  webSave: () => void;
  runtime?: SimulatorPdfRuntime;
  saveCapacitor?: (filename: string, base64Data: string) => Promise<string>;
  saveMac?: (filename: string, base64Data: string) => Promise<string>;
};

type MacSaveResult = {
  requestId: string;
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
};

export function pdfDataUriToBase64(dataUri: string) {
  const separator = dataUri.indexOf(",");
  if (separator < 0 || !dataUri.slice(0, separator).includes("base64")) {
    throw new Error("The generated PDF data is invalid.");
  }
  return dataUri.slice(separator + 1);
}

export function detectSimulatorPdfRuntime(): SimulatorPdfRuntime {
  if (isNativeMacRuntime()) return "mac";
  if (Capacitor.isNativePlatform()) return "capacitor";
  return "web";
}

async function saveWithCapacitor(filename: string, base64Data: string) {
  const [{ Directory, Filesystem }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"),
    import("@capacitor/share"),
  ]);
  const result = await Filesystem.writeFile({
    path: `Simulator Results/${filename}`,
    data: base64Data,
    directory: Directory.Documents,
    recursive: true,
  });

  let shareSheetOpened = false;
  try {
    await Share.share({
      title: "BremLogic Simulator Results",
      text: "BremLogic simulator results PDF",
      files: [result.uri],
      dialogTitle: "Save or share simulator results",
    });
    shareSheetOpened = true;
  } catch {
    // The PDF is already safely stored even if the share sheet is dismissed.
  }

  return shareSheetOpened
    ? "PDF saved in On My iPhone/iPad > BremLogic > Simulator Results. A share sheet was also opened for saving another copy."
    : "PDF saved in On My iPhone/iPad > BremLogic > Simulator Results.";
}

async function saveWithMac(filename: string, base64Data: string) {
  if (typeof window === "undefined") throw new Error("The macOS save dialog is unavailable.");

  const runtimeWindow = window as Window & {
    webkit?: {
      messageHandlers?: {
        bremLogicFiles?: { postMessage: (message: unknown) => void };
      };
    };
  };
  const handler = runtimeWindow.webkit?.messageHandlers?.bremLogicFiles;
  if (!handler) throw new Error("Update the BremLogic Mac app to enable native PDF saving.");

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await new Promise<MacSaveResult>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("bremlogic:native-file-result", onResult as EventListener);
      reject(new Error("The macOS save dialog did not respond."));
    }, 120_000);
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<MacSaveResult>).detail;
      if (detail?.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("bremlogic:native-file-result", onResult as EventListener);
      resolve(detail);
    };
    window.addEventListener("bremlogic:native-file-result", onResult as EventListener);
    handler.postMessage({ action: "savePdf", requestId, filename, base64Data });
  });

  if (result.cancelled) return "PDF save cancelled.";
  if (!result.ok) throw new Error(result.error || "The PDF could not be saved on this Mac.");
  return result.path ? `PDF saved to ${result.path}.` : "PDF saved on this Mac.";
}

export async function saveSimulatorPdf({
  dataUri,
  filename,
  webSave,
  runtime = detectSimulatorPdfRuntime(),
  saveCapacitor = saveWithCapacitor,
  saveMac = saveWithMac,
}: SaveSimulatorPdfOptions) {
  if (runtime === "web") {
    webSave();
    return "PDF downloaded with the graph and complete results.";
  }

  const base64Data = pdfDataUriToBase64(dataUri);
  return runtime === "capacitor"
    ? saveCapacitor(filename, base64Data)
    : saveMac(filename, base64Data);
}
