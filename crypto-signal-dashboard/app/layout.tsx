import "./globals.css";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { NativeShellConfigurator } from "@/app/components/NativeShellConfigurator";
import { NativeSplashController } from "@/app/components/NativeSplashController";
import { TopMenu } from "@/app/components/TopMenu";

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
    <html lang="en" className={isNativeRequest ? "native-preload-shell" : undefined}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var ua=navigator.userAgent||'';var hasBridge=!!(window.Capacitor||window.webkit&&window.webkit.messageHandlers&&(window.webkit.messageHandlers.bridge||window.webkit.messageHandlers.capacitor));if(hasBridge||/BremLogicNative|Capacitor/i.test(ua)){document.documentElement.classList.add('native-preload-shell');}else{document.documentElement.classList.remove('native-preload-shell');}}catch(e){document.documentElement.classList.remove('native-preload-shell');}})();`,
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
        <TopMenu />
        {children}
      </body>
    </html>
  );
}
