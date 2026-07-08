"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const SIGNALS_BOT_TAB_EVENT = "bremlogic:signals-bot-tab-change";

const MENU_ITEMS: Array<{ href: string; label: string; external?: boolean }> = [
  { href: "/signals-bot?tab=signals", label: "Signals" },
  { href: "/signals-bot?tab=perps", label: "Perps" },
  { href: "/simulator", label: "Simulator" },
  { href: "/signals-bot?tab=wallet", label: "Wallet" },
];

export function TopMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const isActive = (href: string) => {
    if (href === "/signals-bot?tab=signals") {
      return pathname === "/signals-bot" && currentTab === "signals";
    }
    if (href === "/signals-bot?tab=perps") {
      return pathname === "/signals-bot" && currentTab === "perps";
    }
    if (href === "/signals-bot?tab=wallet") {
      return pathname === "/signals-bot" && currentTab === "wallet";
    }
    if (href === "/simulator") {
      return pathname === "/simulator";
    }
    return pathname === href;
  };

  useEffect(() => {
    const syncTab = () => {
      if (typeof window === "undefined") return;
      setCurrentTab(new URLSearchParams(window.location.search).get("tab"));
    };

    syncTab();

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("popstate", syncTab);
    window.addEventListener(SIGNALS_BOT_TAB_EVENT, syncTab);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("popstate", syncTab);
      window.removeEventListener(SIGNALS_BOT_TAB_EVENT, syncTab);
    };
  }, []);

  const handleSignalsBotTabNavigation = (href: string) => {
    if (typeof window === "undefined") return;
    const nextUrl = new URL(href, window.location.origin);
    if (nextUrl.pathname !== "/signals-bot") {
      window.location.assign(nextUrl.toString());
      return;
    }
    window.history.pushState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
    window.dispatchEvent(new Event(SIGNALS_BOT_TAB_EVENT));
  };

  return (
    <div ref={containerRef} className="top-menu">
      <button
        type="button"
        className={`top-menu-button ${open ? "open" : ""}`}
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="top-menu-icon" aria-hidden="true">
          <span className="top-menu-line top-menu-line-top" />
          <span className="top-menu-line top-menu-line-bottom" />
        </span>
      </button>
      {open ? (
        <div className="top-menu-dropdown">
          {MENU_ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className={`top-menu-link ${isActive(item.href) ? "active" : ""}`}
              onClick={(event) => {
                setOpen(false);
                if (item.external || pathname !== "/signals-bot" || !item.href.startsWith("/signals-bot")) {
                  return;
                }
                event.preventDefault();
                handleSignalsBotTabNavigation(item.href);
              }}
            >
              {item.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
