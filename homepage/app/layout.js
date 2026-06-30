import "./globals.css";

export const metadata = {
  title: "BremLogic",
  description: "AI-powered crypto trading dashboard and simulator by BremLogic.",
  metadataBase: new URL("https://www.bremlogic.com"),
  applicationName: "BremLogic",
  manifest: "/manifest.json",
  alternates: {
    canonical: "https://www.bremlogic.com",
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
    title: "BremLogic",
    description: "AI-powered crypto trading dashboard and simulator by BremLogic.",
    url: "https://www.bremlogic.com",
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
    title: "BremLogic",
    description: "AI-powered crypto trading dashboard and simulator by BremLogic.",
    images: ["/bremlogic-logo.png"],
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
