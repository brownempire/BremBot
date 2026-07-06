"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

const MIN_SPLASH_MS = 1600;
const BOOT_SPLASH_ID = "native-boot-splash";

export function NativeSplashController() {
  useEffect(() => {
    const overlay = document.getElementById(BOOT_SPLASH_ID);
    if (!overlay) {
      return;
    }

    if (!Capacitor.isNativePlatform()) {
      overlay.remove();
      return;
    }

    const startedAt = Date.now();
    const video = overlay.querySelector("video");
    if (video instanceof HTMLVideoElement) {
      video.currentTime = 0;
      void video.play().catch(() => undefined);
    }

    let hideTimer = 0;

    const hide = () => {
      const remaining = Math.max(0, MIN_SPLASH_MS - (Date.now() - startedAt));
      hideTimer = window.setTimeout(() => {
        overlay.classList.add("is-hidden");
        window.setTimeout(() => {
          overlay.remove();
        }, 220);
      }, remaining);
    };

    if (document.readyState === "complete") {
      hide();
    } else {
      window.addEventListener("load", hide, { once: true });
    }

    return () => {
      window.removeEventListener("load", hide);
      window.clearTimeout(hideTimer);
    };
  }, []);

  return null;
}
