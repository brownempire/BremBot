"use client";

import { usePathname, useRouter } from "next/navigation";

type TabItem = {
  href: string;
  label: string;
  external?: boolean;
  icon: (active: boolean) => React.ReactNode;
};

function ChartIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 18V6m0 12h16M8 14l3-3 3 2 4-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SignalIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12h3l2-5 4 10 2-5h3"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CoinIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
      />
      <path
        d="M9.5 9.5c.4-1 1.4-1.5 2.7-1.5 1.5 0 2.8.8 2.8 2.1 0 2.8-4.7 1.5-4.7 4.2 0 .9.8 1.7 2.3 1.7 1.1 0 2-.4 2.6-1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AiIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4 6 7.5v9L12 20l6-3.5v-9L12 4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
        strokeLinejoin="round"
      />
      <path
        d="M9.5 12h5M12 9.5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.75}
        strokeLinecap="round"
      />
    </svg>
  );
}

function SimIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="4.5"
        y="6"
        width="15"
        height="12"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
      />
      <path
        d="M8.5 10h7M8.5 14h4"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.75}
        strokeLinecap="round"
      />
    </svg>
  );
}

const TAB_ITEMS: TabItem[] = [
  { href: "/", label: "Home", icon: ChartIcon },
  { href: "/signals-bot", label: "Signals", icon: SignalIcon },
  { href: "/memecoin-bot", label: "Meme", icon: CoinIcon },
  { href: "/ai-trading-bot", label: "AI", icon: AiIcon },
  { href: "https://www.bremlogic.com/simulator", label: "Simulator", icon: SimIcon, external: true },
];

export function BottomTabs() {
  const pathname = usePathname();
  const router = useRouter();

  const navigateTo = (item: TabItem) => {
    if (item.external) {
      window.location.assign(item.href);
      return;
    }

    router.push(item.href);
  };

  return (
    <nav className="bottom-tabs" aria-label="Primary">
      <div className="bottom-tabs-shell">
        {TAB_ITEMS.map((item) => {
          const active = !item.external && pathname === item.href;
          return (
            <button
              key={item.href}
              type="button"
              className={`bottom-tab-button ${active ? "active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => navigateTo(item)}
            >
              <span className="bottom-tab-icon">{item.icon(active)}</span>
              <span className="bottom-tab-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
