import Image from "next/image";

export default function HomePage() {
  return (
    <main className="homepage">
      <section className="card hero-card">
        <Image
          className="hero-logo"
          src="/header-photo.png"
          alt="BremLogic"
          width={720}
          height={405}
          priority
        />
        <h1>AI-Powered Crypto Trading Dashboard</h1>
        <p className="lead">
          Track market momentum, monitor live signals, and execute strategy like a true professional
          from the app dashboard.
        </p>
        <a className="cta" href="/signals-bot?tab=signals">
          Open App
        </a>
      </section>
    </main>
  );
}
