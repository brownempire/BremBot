import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Crypto Signals | BremLogic",
  description:
    "Open BremLogic's crypto signals dashboard to monitor markets, wallets, alerts, and automated workflows.",
  alternates: {
    canonical: "https://app.bremlogic.com/signals-bot",
  },
  openGraph: {
    title: "Crypto Signals | BremLogic",
    description:
      "Open BremLogic's crypto signals dashboard to monitor markets, wallets, alerts, and automated workflows.",
    url: "https://app.bremlogic.com/signals-bot",
    siteName: "BremLogic",
    images: ["/opengraph-image.png"],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Crypto Signals | BremLogic",
    description:
      "Open BremLogic's crypto signals dashboard to monitor markets, wallets, alerts, and automated workflows.",
    images: ["/twitter-image.png"],
  },
};

export default function SignalsBotLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
