"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const MENU_ITEMS = [
  { href: "https://www.bremlogic.com", label: "Home", external: true },
  { href: "/signals-bot", label: "Signals" },
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
    if (href === "/signals-bot") {
      return pathname === "/signals-bot" && currentTab !== "perps" && currentTab !== "wallet";
    }
    if (href === "/signals-bot?tab=perps") {
      return pathname === "/signals-bot" && currentTab === "perps";
    }
    if (href === "/signals-bot?tab=wallet") {
      return pathname === "/signals-bot" && currentTab === "wallet";
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
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("popstate", syncTab);
    };
  }, []);

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
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
