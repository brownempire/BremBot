"use client";

import { useEffect } from "react";
import { isNativeIosRuntime, isNativeShellRuntime } from "@/app/lib/nativeShell";

export function NativeShellConfigurator() {
  useEffect(() => {
    if (typeof document === "undefined" || !isNativeShellRuntime()) {
      return;
    }

    document.body.classList.add("native-shell");

    if (isNativeIosRuntime()) {
      document.body.classList.add("native-ios-shell");
    }

    void (async () => {
      try {
        const [{ StatusBar, Style }, { Capacitor }] = await Promise.all([
          import("@capacitor/status-bar"),
          import("@capacitor/core"),
        ]);

        if (!Capacitor.isNativePlatform()) {
          return;
        }

        await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
        await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
      } catch {
        // Ignore plugin/bootstrap errors outside the native shell.
      }
    })();
  }, []);

  return null;
}
