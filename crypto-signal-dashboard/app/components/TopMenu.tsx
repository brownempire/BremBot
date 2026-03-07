"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

const MENU_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/signals-bot", label: "Signals Bot" },
  { href: "/memecoin-bot", label: "Memecoin Bot" },
  { href: "/ai-trading-bot", label: "AI Trading Bot" },
];

export function TopMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const activeLabel = useMemo(
    () => MENU_ITEMS.find((item) => item.href === pathname)?.label ?? "Menu",
    [pathname]
  );

  return (
    <div className="top-menu">
      <button type="button" className="top-menu-button" onClick={() => setOpen((prev) => !prev)}>
        Menu · {activeLabel}
      </button>
      {open ? (
        <div className="top-menu-dropdown" onMouseLeave={() => setOpen(false)}>
          {MENU_ITEMS.map((item) => (
            <Link
              key={item.href}
              className={`top-menu-link ${pathname === item.href ? "active" : ""}`}
              href={item.href}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
