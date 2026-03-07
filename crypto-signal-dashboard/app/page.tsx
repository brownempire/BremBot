import Image from "next/image";
import Link from "next/link";

const BOT_ITEMS = [
  {
    href: "/signals-bot",
    title: "Signals Bot",
    description: "Real-time crypto signal dashboard with wallet, push alerts, and auto-trade controls.",
  },
  {
    href: "/memecoin-bot",
    title: "Memecoin Bot",
    description: "Focused memecoin monitoring and execution workspace.",
  },
  {
    href: "/ai-trading-bot",
    title: "AI Trading Bot",
    description: "AI-assisted strategy and execution interface.",
  },
];

export default function HomePage() {
  return (
    <main className="bot-home">
      <Image
        className="bot-home-top-logo"
        src="/header-photo.png"
        alt="BremLogic"
        width={1038}
        height={338}
        priority
      />
      <section className="bot-home-center panel">
        <Image
          className="bot-home-favicon"
          src="/favicon.ico"
          alt="BremLogic favicon"
          width={72}
          height={72}
          priority
        />
        <p className="subtext">Choose a bot to continue.</p>
        <div className="bot-home-grid">
          {BOT_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className="bot-home-card">
              <h3>{item.title}</h3>
              <p>{item.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
