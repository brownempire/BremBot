import "./globals.css";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { BottomTabs } from "@/app/components/BottomTabs";
import { NativeShellConfigurator } from "@/app/components/NativeShellConfigurator";
import { NativeSplashController } from "@/app/components/NativeSplashController";

export const metadata: Metadata = {
  title: "BremLogic — Crypto Signals",
  description:
    "Welcome to BremLogic. Real-time trading signals with in-app wallet controls plus interactive charts from TradingView.",
  metadataBase: new URL("https://app.bremlogic.com"),
  applicationName: "BremLogic",
  manifest: "/manifest.json",
  alternates: {
    canonical: "https://app.bremlogic.com",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/favicon.ico"],
  },
  appleWebApp: {
    title: "BremLogic",
    capable: true,
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    title: "BremLogic — Crypto Signals",
    description:
      "Welcome to BremLogic. Real-time trading signals with in-app wallet controls plus interactive charts from TradingView.",
    url: "https://app.bremlogic.com",
    siteName: "BremLogic",
    images: [
      {
        url: "/bremlogic-logo.png",
        width: 1038,
        height: 338,
        alt: "BremLogic",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "BremLogic — Crypto Signals",
    description:
      "Welcome to BremLogic. Real-time trading signals with in-app wallet controls plus interactive charts from TradingView.",
    images: ["/bremlogic-logo.png"],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent") ?? "";
  const isNativeRequest = /BremLogicNative|Capacitor/i.test(userAgent);

  return (
    <html
      lang="en"
      className={isNativeRequest ? "native-preload-shell" : undefined}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var ua=navigator.userAgent||'';var hasBridge=!!(window.Capacitor&&typeof window.Capacitor.isNativePlatform==='function'&&window.Capacitor.isNativePlatform()||window.webkit&&window.webkit.messageHandlers&&(window.webkit.messageHandlers.bridge||window.webkit.messageHandlers.capacitor));var isStandalone=!!((window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone);var nativeShellHint=false;try{var currentUrl=new URL(window.location.href);var nativeShellParam=currentUrl.searchParams.get('nativeShell');if(nativeShellParam==='ios'||nativeShellParam==='true'||nativeShellParam==='1'){window.sessionStorage.setItem('bremlogic.native-shell.runtime.v1','true');window.localStorage.removeItem('bremlogic.native-shell.runtime.v1');nativeShellHint=true;}else if(nativeShellParam==='false'||nativeShellParam==='0'){window.sessionStorage.removeItem('bremlogic.native-shell.runtime.v1');window.localStorage.removeItem('bremlogic.native-shell.runtime.v1');}else{nativeShellHint=window.sessionStorage.getItem('bremlogic.native-shell.runtime.v1')==='true';}}catch(_ignored){}if(hasBridge||/BremLogicNative|Capacitor/i.test(ua)||nativeShellHint){document.documentElement.classList.add('native-preload-shell');}else{document.documentElement.classList.remove('native-preload-shell');}if(isStandalone){document.documentElement.classList.add('pwa-standalone-shell');}else{document.documentElement.classList.remove('pwa-standalone-shell');}}catch(e){document.documentElement.classList.remove('native-preload-shell');document.documentElement.classList.remove('pwa-standalone-shell');}})();`,
          }}
        />
      </head>
      <body>
        <div
          id="native-boot-splash"
          className="native-splash-overlay native-splash-overlay-boot"
          aria-hidden="true"
        >
          <video
            className="native-splash-video"
            autoPlay
            playsInline
            muted
            loop
            preload="auto"
            disablePictureInPicture
            controls={false}
            controlsList="nodownload noplaybackrate nofullscreen noremoteplayback"
            aria-hidden="true"
            suppressHydrationWarning
            {...{
              "webkit-playsinline": "true",
            }}
          >
            <source src="/splash/splashscreen.mp4" type="video/mp4" />
          </video>
          <div className="native-splash-shade" />
        </div>
        <NativeShellConfigurator />
        <NativeSplashController />
        <div className="app-viewport">
          <div className="app-scroll-shell">{children}</div>
          <BottomTabs />
        </div>
      </body>
    </html>
  );
}
