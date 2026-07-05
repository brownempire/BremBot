import crypto from "node:crypto";
import http2 from "node:http2";

import { removeNativePushDevice, type NativePushDeviceRecord } from "@/lib/push/nativeStore";

const APNS_KEY_ID = process.env.APNS_KEY_ID?.trim();
const APNS_TEAM_ID = process.env.APNS_TEAM_ID?.trim();
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID?.trim() || "com.bremlogic.signalsbot";
const APNS_PRIVATE_KEY = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
const APNS_USE_SANDBOX = (process.env.APNS_USE_SANDBOX ?? "true").trim().toLowerCase() !== "false";

function encodeBase64Url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createJwt() {
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY) return null;

  const header = encodeBase64Url(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID }));
  const claims = encodeBase64Url(JSON.stringify({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signer = crypto.createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(APNS_PRIVATE_KEY);
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

export function getApnsConfigError() {
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY || !APNS_BUNDLE_ID) {
    return "Missing APNs configuration";
  }
  return null;
}

export async function sendApnsPayload(
  devices: NativePushDeviceRecord[],
  payload: {
    title: string;
    body: string;
    url?: string;
  }
) {
  const jwt = createJwt();
  if (!jwt) {
    return { sent: 0, results: devices.map((device) => ({ token: device.token, ok: false, statusCode: 0 })) };
  }

  const authority = APNS_USE_SANDBOX ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const client = http2.connect(authority);

  const results = await Promise.all(
    devices.map((device) => new Promise<{ token: string; ok: boolean; statusCode: number }>((resolve) => {
      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${jwt}`,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-topic": APNS_BUNDLE_ID,
      });

      let statusCode = 0;
      let responseBody = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        statusCode = Number(headers[http2.constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on("data", (chunk) => {
        responseBody += chunk;
      });
      request.on("end", async () => {
        if (statusCode === 410 || statusCode === 400) {
          await removeNativePushDevice(device.token);
        }
        resolve({
          token: device.token,
          ok: statusCode === 200,
          statusCode: statusCode || (responseBody ? 500 : 0),
        });
      });
      request.on("error", () => {
        resolve({ token: device.token, ok: false, statusCode: 0 });
      });

      request.write(JSON.stringify({
        aps: {
          alert: {
            title: payload.title,
            body: payload.body,
          },
          sound: "default",
        },
        url: payload.url ?? "/signals-bot",
      }));
      request.end();
    }))
  );

  client.close();
  return {
    sent: results.filter((result) => result.ok).length,
    results,
  };
}
