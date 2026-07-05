import { getApnsConfigError, sendApnsPayload } from "@/lib/push/apnsSender";
import { listNativePushDevices } from "@/lib/push/nativeStore";
import { getTargetSubscriptions, hasWebPushConfig, sendPushPayload } from "@/lib/push/sender";

export function getAnyPushConfigError() {
  const hasWeb = hasWebPushConfig();
  const hasApns = !getApnsConfigError();
  if (!hasWeb && !hasApns) {
    return "Missing push configuration";
  }
  return null;
}

export async function sendNotificationPayload(options: {
  title: string;
  body: string;
  url: string;
  subscription?: PushSubscriptionJSON | null;
  walletAddress?: string | null;
  nativeToken?: string | null;
}) {
  const webTargets = hasWebPushConfig()
    ? await getTargetSubscriptions({
        subscription: options.subscription ?? null,
        walletAddress: options.walletAddress ?? null,
      })
    : [];
  const nativeTargets = !getApnsConfigError()
    ? (
      options.nativeToken?.trim()
        ? (await listNativePushDevices()).filter((device) => device.token === options.nativeToken)
        : await listNativePushDevices(options.walletAddress ?? null)
    )
    : [];

  const [webResult, nativeResult] = await Promise.all([
    webTargets.length > 0
      ? sendPushPayload(webTargets, {
          title: options.title,
          body: options.body,
          url: options.url,
        })
      : Promise.resolve({ sent: 0, results: [] as Array<{ endpoint?: string; ok: boolean; statusCode?: number }> }),
    nativeTargets.length > 0
      ? sendApnsPayload(nativeTargets, {
          title: options.title,
          body: options.body,
          url: options.url,
        })
      : Promise.resolve({ sent: 0, results: [] as Array<{ token: string; ok: boolean; statusCode: number }> }),
  ]);

  return {
    sent: webResult.sent + nativeResult.sent,
    web: webResult,
    native: nativeResult,
  };
}
