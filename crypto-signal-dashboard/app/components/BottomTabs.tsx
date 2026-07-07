"use client";

import { usePathname, useRouter } from "next/navigation";

type TabItem = {
  href: string;
  label: string;
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
  { href: "/simulator", label: "Simulator", icon: SimIcon },
];

export function BottomTabs() {
  const pathname = usePathname();
  const router = useRouter();

  const navigateTo = (item: TabItem) => {
    router.push(item.href);
  };

  return (
    <nav className="bottom-tabs" aria-label="Primary">
      <div className="bottom-tabs-shell">
        {TAB_ITEMS.map((item) => {
          const active = pathname === item.href;
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
