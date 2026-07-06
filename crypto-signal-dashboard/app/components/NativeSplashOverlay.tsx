"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

const MIN_SPLASH_MS = 1600;

export function NativeSplashOverlay() {
  const [isNative, setIsNative] = useState(false);
  const [visible, setVisible] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      setVisible(false);
      return;
    }

    setIsNative(true);
    const startedAt = Date.now();

    const finish = () => {
      const remaining = Math.max(0, MIN_SPLASH_MS - (Date.now() - startedAt));
      window.setTimeout(() => {
        setVisible(false);
      }, remaining);
    };

    const video = videoRef.current;
    if (video) {
      video.currentTime = 0;
      void video.play().catch(() => undefined);
    }

    if (document.readyState === "complete") {
      finish();
      return;
    }

    window.addEventListener("load", finish, { once: true });
    return () => {
      window.removeEventListener("load", finish);
    };
  }, []);

  if (!isNative || !visible) {
    return null;
  }

  return (
    <div className="native-splash-overlay" aria-hidden="true">
      <video
        ref={videoRef}
        className="native-splash-video"
        autoPlay
        playsInline
        muted
        loop
        preload="auto"
      >
        <source src="/splash/splashscreen.mp4" type="video/mp4" />
      </video>
      <div className="native-splash-shade" />
    </div>
  );
}
