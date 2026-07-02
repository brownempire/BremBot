"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

export function NativeShellConfigurator() {
  useEffect(() => {
    if (typeof document === "undefined" || !Capacitor.isNativePlatform()) {
      return;
    }

    document.body.classList.add("native-shell");

    if (Capacitor.getPlatform() === "ios") {
      document.body.classList.add("native-ios-shell");
    }

    void StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
    void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
  }, []);

  return null;
}
