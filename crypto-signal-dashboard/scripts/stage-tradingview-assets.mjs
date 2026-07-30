import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultDistributionRoot = path.join(os.homedir(), "charting_library");
const distributionRoot = path.resolve(
  process.env.TRADINGVIEW_CHARTING_LIBRARY_PATH || defaultDistributionRoot
);
const source = path.join(distributionRoot, "charting_library");
const destination = path.join(
  projectRoot,
  "public",
  "vendor",
  "tradingview",
  "charting_library"
);
const runtimeEntries = [
  "bundles",
  "charting_library.standalone.js",
  "sameorigin.html",
];

async function readVersion() {
  const packageJson = JSON.parse(
    await readFile(path.join(distributionRoot, "package.json"), "utf8")
  );
  return String(packageJson.version || "unknown");
}

try {
  const version = await readVersion();
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const entry of runtimeEntries) {
    await cp(path.join(source, entry), path.join(destination, entry), { recursive: true });
  }
  await writeFile(
    path.join(destination, ".bremlogic-staged.json"),
    `${JSON.stringify({ version, stagedAt: new Date().toISOString() }, null, 2)}\n`
  );
  console.log(`Staged TradingView Advanced Charts v${version} from ${distributionRoot}`);
} catch (error) {
  console.error(
    [
      "Unable to stage TradingView Advanced Charts.",
      `Expected the licensed distribution at: ${distributionRoot}`,
      "Set TRADINGVIEW_CHARTING_LIBRARY_PATH to another local clone if needed.",
      error instanceof Error ? error.message : String(error),
    ].join("\n")
  );
  process.exitCode = 1;
}
