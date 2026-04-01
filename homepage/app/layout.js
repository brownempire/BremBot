import "./globals.css";
import RegisterSW from "./register-sw";

export const metadata = {
  title: "Network Install Assistant",
  description: "PWA for installer-friendly Wi-Fi survey and setup workflows.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Install Assistant",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
