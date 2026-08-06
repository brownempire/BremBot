"use client";

import { useEffect } from "react";
import { App } from "@capacitor/app";
import { useRouter } from "next/navigation";
import {
  isNativeIosRuntime,
  isNativeShellRuntime,
  isStandalonePwaRuntime,
} from "@/app/lib/nativeShell";

function resolveNativeOpenTarget(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "bremlogic:") {
      const target = url.searchParams.get("target");
      return target && target.startsWith("/") ? target : null;
    }

    if ((url.protocol === "https:" || url.protocol === "http:") && /(^|\.)bremlogic\.com$/i.test(url.hostname)) {
      const target = `${url.pathname}${url.search}${url.hash}`;
      return target.startsWith("/") ? target : null;
    }
  } catch {
    return null;
  }

  return null;
}

export function NativeShellConfigurator() {
  const router = useRouter();

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    if (isStandalonePwaRuntime()) {
      document.documentElement.classList.add("pwa-standalone-shell");
      document.body.classList.add("pwa-standalone-shell");
    }

    if (!isNativeShellRuntime()) {
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

    if (!isNativeIosRuntime()) {
      return;
    }

    const navigateFromUrl = (rawUrl: string | null | undefined) => {
      if (!rawUrl || typeof window === "undefined") return;
      const target = resolveNativeOpenTarget(rawUrl);
      if (!target) return;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (current === target) return;
      const targetUrl = new URL(target, window.location.origin);
      if (targetUrl.pathname === window.location.pathname) {
        window.history.replaceState({}, "", target);
        window.dispatchEvent(new Event("popstate"));
        return;
      }
      router.replace(target);
    };

    const listener = App.addListener("appUrlOpen", (event) => {
      navigateFromUrl(event.url);
    });

    void App.getLaunchUrl()
      .then((result) => {
        navigateFromUrl(result?.url);
      })
      .catch(() => undefined);

    return () => {
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [router]);

  return null;
}
