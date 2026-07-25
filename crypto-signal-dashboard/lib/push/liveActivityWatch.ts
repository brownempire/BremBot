import { sendLiveActivityApnsUpdates } from "@/lib/push/liveActivitySender";
import {
  claimLiveActivityDispatchWindow,
  listLiveActivityPushTokens,
} from "@/lib/push/liveActivityStore";
import { loadWidgetServerSnapshot } from "@/lib/widget/serverSnapshot";

const LIVE_ACTIVITY_REFRESH_INTERVAL_MS = 5 * 60_000;

export async function runLiveActivityUpdateWatch() {
  const records = await listLiveActivityPushTokens();
  if (records.length === 0) {
    return { ok: true, skipped: "NO_ACTIVE_LIVE_ACTIVITIES", tokens: 0, sent: 0, ended: 0 };
  }

  const claimed = await claimLiveActivityDispatchWindow(
    Date.now(),
    LIVE_ACTIVITY_REFRESH_INTERVAL_MS
  );
  if (!claimed) {
    return { ok: true, skipped: "FIVE_MINUTE_WINDOW_ACTIVE", tokens: records.length, sent: 0, ended: 0 };
  }

  const snapshot = await loadWidgetServerSnapshot();
  const result = await sendLiveActivityApnsUpdates({ records, snapshot });
  return {
    ok: result.results.every((entry) => entry.ok),
    tokens: records.length,
    sent: result.sent,
    ended: result.ended,
    results: result.results,
  };
}
