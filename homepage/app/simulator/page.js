import SimulatorClient from "../simulator-client";

export const metadata = {
  title: "Jupiter Perps Simulator | BremLogic",
  description: "Test leveraged perps compounding, fees, risk, and Monte Carlo outcomes.",
  alternates: {
    canonical: "https://www.bremlogic.com/simulator",
  },
  openGraph: {
    title: "Jupiter Perps Simulator | BremLogic",
    description: "Test leveraged perps compounding, fees, risk, and Monte Carlo outcomes.",
    url: "https://www.bremlogic.com/simulator",
    siteName: "BremLogic",
    images: [
      {
        url: "/bremlogic-logo.png",
        width: 1038,
        height: 338,
        alt: "BremLogic Jupiter Perps Simulator",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Jupiter Perps Simulator | BremLogic",
    description: "Test leveraged perps compounding, fees, risk, and Monte Carlo outcomes.",
    images: ["/bremlogic-logo.png"],
  },
};

export default function SimulatorPage() {
  return <SimulatorClient />;
}
