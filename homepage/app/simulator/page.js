import SimulatorClient from "../simulator-client";

export const metadata = {
  description: "Test leveraged perps compounding, fees, risk, and Monte Carlo outcomes.",
  alternates: {
    canonical: "https://www.bremlogic.com/simulator",
  },
  openGraph: {
    title: "Jupiter Perps Simulator | BremLogic",
    description: "Test leveraged perps compounding, fees, risk, and Monte Carlo outcomes.",
    url: "https://www.bremlogic.com/simulator",
    siteName: "BremLogic",
    images: ["/simulator/opengraph-image.png"],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Jupiter Perps Simulator | BremLogic",
    description: "Test leveraged perps compounding, fees, risk, and Monte Carlo outcomes.",
    images: ["/simulator/twitter-image.png"],
  },
};

export default function SimulatorPage() {
  return <SimulatorClient />;
}
