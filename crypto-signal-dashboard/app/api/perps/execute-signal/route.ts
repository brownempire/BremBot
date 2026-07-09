import { NextRequest } from "next/server";

import { getPerpsRuntimeOverride } from "@/lib/perps/auditLog";
import { getPerpsRuntimeSettings, getPerpsWebhookSecret } from "@/lib/perps/config";
import { executePerpsSignal } from "@/lib/perps/engine";
import { PerpsExecutionError } from "@/lib/perps/errors";
import { assertValidPerpsWebhookSignature } from "@/lib/perps/security";
import { perpsSignalSchema } from "@/lib/perps/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  try {
    assertValidPerpsWebhookSignature({
      secret: getPerpsWebhookSecret(),
      signature: request.headers.get("x-bremlogic-signature") ?? undefined,
      timestamp: request.headers.get("x-bremlogic-timestamp") ?? undefined,
      nonce: request.headers.get("x-bremlogic-nonce") ?? undefined,
      body: rawBody,
    });

    const parsedBody = JSON.parse(rawBody || "{}");
    const signal = perpsSignalSchema.parse(parsedBody);
    const runtimeSettings = getPerpsRuntimeSettings();
    const runtimeOverride = await getPerpsRuntimeOverride();
    const result = await executePerpsSignal(signal, {
      killSwitchOverride: runtimeOverride.killSwitchOverride,
    });

    return Response.json({
      ...result,
      killSwitch: runtimeOverride.killSwitchOverride ?? runtimeSettings.killSwitch,
      paperTrading: runtimeSettings.paperTrading,
      accountLabel: runtimeSettings.paperTrading ? "Paper account" : "Real account",
    }, { status: result.ok ? 200 : 409 });
  } catch (error) {
    if (error instanceof PerpsExecutionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }

    if (error instanceof Error && error.name === "ZodError") {
      return Response.json({ error: "Invalid perps signal payload.", detail: error.message }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Unable to process the perps signal.";
    return Response.json({ error: message }, { status: 500 });
  }
}
