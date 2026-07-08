"use client";

import { useEffect } from "react";

const MIN_SPLASH_MS = 1600;
const BOOT_SPLASH_ID = "native-boot-splash";

export function NativeSplashController() {
  useEffect(() => {
    const overlay = document.getElementById(BOOT_SPLASH_ID);
    if (!overlay) {
      return;
    }

    const startedAt = Date.now();
    const video = overlay.querySelector("video");
    let removePlaybackListeners: (() => void) | null = null;
    if (video instanceof HTMLVideoElement) {
      video.autoplay = true;
      video.defaultMuted = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.controls = false;
      video.setAttribute("autoplay", "");
      video.setAttribute("muted", "");
      video.setAttribute("loop", "");
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "true");
      video.setAttribute("disableRemotePlayback", "true");
      video.removeAttribute("controls");
      video.currentTime = 0;
      const tryPlay = () => {
        void video.play().catch(() => undefined);
      };
      video.load();
      tryPlay();

      const onReady = () => {
        tryPlay();
      };
      video.addEventListener("loadedmetadata", onReady);
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("canplay", onReady);
      removePlaybackListeners = () => {
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
      };
    }

    let hideTimer = 0;
    let removeTimer = 0;
    let hidden = false;

    const hide = () => {
      if (hidden) return;
      hidden = true;
      const remaining = Math.max(0, MIN_SPLASH_MS - (Date.now() - startedAt));
      hideTimer = window.setTimeout(() => {
        overlay.classList.add("is-hidden");
        removeTimer = window.setTimeout(() => {
          overlay.remove();
        }, 220);
      }, remaining);
    };

    hide();

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
      removePlaybackListeners?.();
    };
  }, []);

  return null;
}
