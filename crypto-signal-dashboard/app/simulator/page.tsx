import { redirect } from "next/navigation";

export default function SimulatorPage() {
  redirect("/signals-bot?tab=simulator");
}
