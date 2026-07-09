import crypto from "node:crypto";

import { PerpsExecutionError } from "@/lib/perps/errors";

const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

function safeCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function computePerpsWebhookSignature(secret: string, timestamp: string, nonce: string, body: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest("hex");
}

export function assertValidPerpsWebhookSignature(input: {
  secret: string | null;
  signature?: string;
  timestamp?: string;
  nonce?: string;
  body: string;
}) {
  if (!input.secret) {
    return { accepted: true, mode: "unsigned" as const };
  }

  const signature = input.signature?.trim() ?? "";
  const timestamp = input.timestamp?.trim() ?? "";
  const nonce = input.nonce?.trim() ?? "";

  if (!signature || !timestamp || !nonce) {
    throw new PerpsExecutionError("MISSING_WEBHOOK_SIGNATURE", "Missing Bremlogic webhook signature headers.", 401);
  }

  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) {
    throw new PerpsExecutionError("INVALID_WEBHOOK_TIMESTAMP", "Webhook timestamp is invalid.", 401);
  }

  if (Math.abs(Date.now() - numericTimestamp) > MAX_WEBHOOK_AGE_MS) {
    throw new PerpsExecutionError("STALE_WEBHOOK_TIMESTAMP", "Webhook timestamp is outside the allowed window.", 401);
  }

  const expected = computePerpsWebhookSignature(input.secret, timestamp, nonce, input.body);
  if (!safeCompare(signature, expected)) {
    throw new PerpsExecutionError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature verification failed.", 401);
  }

  return { accepted: true, mode: "signed" as const };
}
