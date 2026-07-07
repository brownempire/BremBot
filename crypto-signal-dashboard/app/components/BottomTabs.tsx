"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

type TabItem = {
  href: string;
  label: string;
  external?: boolean;
  match?: (pathname: string, tab: string | null) => boolean;
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

function PerpsIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 16.5 9 12l3 2.5 7-7"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 7.5h5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WalletIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.5 8.5c0-1.7 1.3-3 3-3h9c1.7 0 3 1.3 3 3v7c0 1.7-1.3 3-3 3h-9c-1.7 0-3-1.3-3-3v-7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.9}
      />
      <path
        d="M15.5 12h4"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.75}
        strokeLinecap="round"
      />
      <circle cx="15.5" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

const TAB_ITEMS: TabItem[] = [
  { href: "https://www.bremlogic.com", label: "Home", icon: ChartIcon, external: true },
  {
    href: "/signals-bot",
    label: "Signals",
    icon: SignalIcon,
    match: (pathname, tab) => pathname === "/signals-bot" && tab !== "perps" && tab !== "wallet",
  },
  {
    href: "/signals-bot?tab=perps",
    label: "Perps",
    icon: PerpsIcon,
    match: (pathname, tab) => pathname === "/signals-bot" && tab === "perps",
  },
  {
    href: "/simulator",
    label: "Simulator",
    icon: SimIcon,
    match: (pathname) => pathname === "/simulator",
  },
  {
    href: "/signals-bot?tab=wallet",
    label: "Wallet",
    icon: WalletIcon,
    match: (pathname, tab) => pathname === "/signals-bot" && tab === "wallet",
  },
];

export function BottomTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentTab = searchParams.get("tab");

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
          const active = item.match ? item.match(pathname, currentTab) : pathname === item.href;
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
