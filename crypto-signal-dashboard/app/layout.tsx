import "./globals.css";
import type { Metadata } from "next";
import { NativeShellConfigurator } from "@/app/components/NativeShellConfigurator";
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <NativeShellConfigurator />
        <TopMenu />
        {children}
      </body>
    </html>
  );
}
