import { Capacitor, registerPlugin } from "@capacitor/core";

export type BremLogicWidgetSnapshotPayload = {
  title: string;
  latestSignalSymbol?: string | null;
  latestSignalSummary?: string | null;
  latestSignalDirection?: string | null;
  latestSignalConfidence?: number | null;
  walletBalanceUsd?: number | null;
  autoTradeStatus?: string | null;
  perpsAutoTradeStatus?: string | null;
  perpsSessionState?: string | null;
  perpsMode?: string | null;
  perpsExecutionModel?: string | null;
  updatedAt: number;
  targetURL: string;
};

type WidgetSyncPlugin = {
  saveSnapshot(snapshot: BremLogicWidgetSnapshotPayload): Promise<{ ok: boolean }>;
  getSnapshot(): Promise<BremLogicWidgetSnapshotPayload>;
  reloadTimelines(): Promise<{ ok: boolean }>;
};

const WidgetSync = registerPlugin<WidgetSyncPlugin>("WidgetSync", {
  web: async () => ({
    async saveSnapshot() {
      return { ok: false };
    },
    async getSnapshot() {
      throw new Error("WidgetSync is only available in the native iOS app.");
    },
    async reloadTimelines() {
      return { ok: false };
    },
  }),
});

export async function syncWidgetSnapshot(snapshot: BremLogicWidgetSnapshotPayload) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") {
    return;
  }

  await WidgetSync.saveSnapshot(snapshot);
}

export async function readWidgetSnapshot() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") {
    return null;
  }

  return WidgetSync.getSnapshot();
}
