"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const MENU_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/signals-bot", label: "Signals Bot" },
  { href: "/memecoin-bot", label: "Memecoin Bot" },
  { href: "/ai-trading-bot", label: "AI Trading Bot" },
  { href: "https://www.bremlogic.com/simulator", label: "Simulator" },
];

export function TopMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const navigateTo = (href: string) => {
    setOpen(false);
    if (typeof window !== "undefined") {
      window.location.assign(href);
    }
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
              className={`top-menu-link ${pathname === item.href ? "active" : ""}`}
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
