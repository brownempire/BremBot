"use client";

import { usePathname, useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const currentTab = searchParams.get("tab");

  const navigateTo = (href: string) => {
    setOpen(false);
    if (typeof window !== "undefined") {
      window.location.assign(href);
    }
  };

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
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
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
            <button
              type="button"
              key={item.href}
              className={`top-menu-link ${isActive(item.href) ? "active" : ""}`}
              onPointerDown={() => navigateTo(item.href)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
