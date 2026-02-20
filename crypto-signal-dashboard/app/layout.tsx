import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PulseSignal — Crypto Signals",
  description: "Real-time crypto trading signal dashboard.",
  manifest: "/manifest.json"
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
