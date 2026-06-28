import SimulatorClient from "../simulator-client";

export const metadata = {
  title: "Jupiter Perps Simulator | BremLogic",
  description: "Test leveraged perps compounding, fees, risk, and Monte Carlo outcomes.",
};

export default function SimulatorPage() {
  return <SimulatorClient />;
}
