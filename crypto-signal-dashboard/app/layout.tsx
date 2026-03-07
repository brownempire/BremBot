import "./globals.css";
import type { Metadata } from "next";
import { TopMenu } from "@/app/components/TopMenu";

export const metadata: Metadata = {
  title: "BremLogic — Crypto Signals",
  description:
    "Welcome to BremLogic. Real-time trading signals with in-app wallet controls plus interactive charts from TradingView.",
  manifest: "/manifest.json",
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
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <TopMenu />
        {children}
      </body>
    </html>
  );
}
