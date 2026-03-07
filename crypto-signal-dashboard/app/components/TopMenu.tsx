"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

const MENU_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/signals-bot", label: "Signals Bot" },
  { href: "/memecoin-bot", label: "Memecoin Bot" },
  { href: "/ai-trading-bot", label: "AI Trading Bot" },
];

export function TopMenu() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const activeLabel = useMemo(
    () => MENU_ITEMS.find((item) => item.href === pathname)?.label ?? "Menu",
    [pathname]
  );
  const navigateTo = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <div className="top-menu">
      <button type="button" className="top-menu-button" onClick={() => setOpen((prev) => !prev)}>
        Menu · {activeLabel}
      </button>
      {open ? (
        <div className="top-menu-dropdown" onMouseLeave={() => setOpen(false)}>
          {MENU_ITEMS.map((item) => (
            <button
              type="button"
              key={item.href}
              className={`top-menu-link ${pathname === item.href ? "active" : ""}`}
              onClick={() => navigateTo(item.href)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
