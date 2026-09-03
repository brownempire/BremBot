import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const componentSource = fs.readFileSync(
  path.join(process.cwd(), "app/components/JupiterPerpsPositionWidget.tsx"),
  "utf8"
);
const styleSource = fs.readFileSync(
  path.join(process.cwd(), "app/globals.css"),
  "utf8"
);

test("Perps position panel shows smaller ROE beside unrealized PnL", () => {
  assert.match(componentSource, /estimateNetExitPnl\(position\)/);
  assert.match(componentSource, /estimate\?\.estimatedNetRoePercent/);
  assert.match(componentSource, /`\(\$\{pnlPercent >= 0 \? "\+" : ""\}\$\{pnlPercent\.toFixed\(2\)\}%\)`/);
  assert.match(componentSource, /label="Est\. net PnL"[\s\S]*secondaryValue=\{pnlPercentLabel\}/);
  assert.match(componentSource, /className="perps-metric-value-secondary"/);
  assert.match(styleSource, /\.perps-metric-value-row\s*\{[\s\S]*align-items: baseline/);
  assert.match(styleSource, /\.perps-metric-value-secondary\s*\{[\s\S]*font-size: 0\.78em/);
});
