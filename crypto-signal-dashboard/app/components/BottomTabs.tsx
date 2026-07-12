"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

const SIGNALS_BOT_TAB_EVENT = "bremlogic:signals-bot-tab-change";
const AI_PANEL_TOGGLE_EVENT = "bremlogic:ai-panel-toggle";
const AI_PANEL_STATE_EVENT = "bremlogic:ai-panel-state";

type TabItem = {
  href: string;
  label: string;
  external?: boolean;
  match?: (pathname: string, tab: string | null) => boolean;
  icon: (active: boolean) => ReactNode;
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

function AiIcon(active: boolean) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 4.5 13.7 8l3.8.6-2.8 2.7.7 3.7L12 13.2 8.6 15l.7-3.7L6.5 8.6 10.3 8 12 4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.1 : 1.85}
        strokeLinejoin="round"
      />
      <circle cx="18.2" cy="6.1" r="1.1" fill="currentColor" />
    </svg>
  );
}

const TAB_ITEMS: TabItem[] = [
  {
    href: "/signals-bot?tab=signals",
    label: "Signals",
    icon: ChartIcon,
    match: (pathname, tab) => pathname === "/signals-bot" && tab === "signals",
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

function renderSignalsTabButton(item: TabItem, pathname: string, currentTab: string | null, handleSignalsBotTabNavigation: (href: string) => void) {
  const active = item.match ? item.match(pathname, currentTab) : pathname === item.href;
  return (
    <a
      key={item.href}
      href={item.href}
      className={`bottom-tab-button ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      onPointerDown={(event) => {
        if (item.external || pathname !== "/signals-bot" || !item.href.startsWith("/signals-bot")) {
          return;
        }
        event.preventDefault();
        handleSignalsBotTabNavigation(item.href);
      }}
      onClick={(event) => {
        if (item.external || pathname !== "/signals-bot" || !item.href.startsWith("/signals-bot")) {
          return;
        }
        event.preventDefault();
      }}
    >
      <span className="bottom-tab-icon">{item.icon(active)}</span>
      <span className="bottom-tab-label">{item.label}</span>
    </a>
  );
}

export function BottomTabs() {
  const pathname = usePathname();
  const [currentTab, setCurrentTab] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    const syncTab = () => {
      if (typeof window === "undefined") return;
      const search = new URLSearchParams(window.location.search);
      setCurrentTab(search.get("tab"));
      setAiOpen(search.get("ai") === "open");
    };

    const syncAiState = (event: Event) => {
      const customEvent = event as CustomEvent<{ open?: boolean }>;
      setAiOpen(Boolean(customEvent.detail?.open));
    };

    syncTab();
    window.addEventListener("popstate", syncTab);
    window.addEventListener(SIGNALS_BOT_TAB_EVENT, syncTab);
    window.addEventListener(AI_PANEL_STATE_EVENT, syncAiState as EventListener);
    return () => {
      window.removeEventListener("popstate", syncTab);
      window.removeEventListener(SIGNALS_BOT_TAB_EVENT, syncTab);
      window.removeEventListener(AI_PANEL_STATE_EVENT, syncAiState as EventListener);
    };
  }, []);

  const handleSignalsBotTabNavigation = (href: string) => {
    if (typeof window === "undefined") return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const nextUrl = new URL(href, window.location.origin);
    if (nextUrl.pathname !== "/signals-bot") {
      window.location.assign(nextUrl.toString());
      return;
    }
    nextUrl.searchParams.delete("ai");
    window.history.pushState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
    window.dispatchEvent(new Event(SIGNALS_BOT_TAB_EVENT));
    window.dispatchEvent(new CustomEvent(AI_PANEL_STATE_EVENT, { detail: { open: false } }));
  };

  const handleAiToggle = () => {
    if (typeof window === "undefined") return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (pathname !== "/signals-bot") {
      window.location.assign("/signals-bot?tab=signals&ai=open");
      return;
    }
    window.dispatchEvent(new Event(AI_PANEL_TOGGLE_EVENT));
  };

  return (
    <nav className="bottom-tabs" aria-label="Primary">
      <div className="bottom-tabs-shell">
        {TAB_ITEMS.slice(0, 2).map((item) => renderSignalsTabButton(item, pathname, currentTab, handleSignalsBotTabNavigation))}
        <button
          type="button"
          className={`bottom-tab-button ${aiOpen ? "active" : ""}`}
          aria-pressed={aiOpen}
          onPointerDown={(event) => {
            event.preventDefault();
            handleAiToggle();
          }}
          onClick={(event) => event.preventDefault()}
        >
          <span className="bottom-tab-icon">{AiIcon(aiOpen)}</span>
          <span className="bottom-tab-label">Ai</span>
        </button>
        {TAB_ITEMS.slice(2).map((item) => renderSignalsTabButton(item, pathname, currentTab, handleSignalsBotTabNavigation))}
      </div>
    </nav>
  );
}
