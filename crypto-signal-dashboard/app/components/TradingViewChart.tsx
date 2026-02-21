"use client";

import { useEffect, useMemo, useRef } from "react";

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

type TradingViewChartProps = {
  symbol?: string;
};

const SCRIPT_ID = "tradingview-widget-script";

export function TradingViewChart({ symbol = "BINANCE:BTCUSDT" }: TradingViewChartProps) {
  const containerId = useMemo(
    () => `tradingview_${Math.random().toString(36).slice(2, 10)}`,
    []
  );
  const initialized = useRef(false);

  useEffect(() => {
    const createWidget = () => {
      if (!window.TradingView || initialized.current) return;

      new window.TradingView.widget({
        autosize: true,
        symbol,
        interval: "30",
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        enable_publishing: false,
        allow_symbol_change: true,
        hide_side_toolbar: false,
        withdateranges: true,
        container_id: containerId,
      });

      initialized.current = true;
    };

    const existingScript = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existingScript) {
      if (window.TradingView) {
        createWidget();
      } else {
        existingScript.addEventListener("load", createWidget, { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.addEventListener("load", createWidget, { once: true });
    document.head.appendChild(script);

    return () => {
      script.removeEventListener("load", createWidget);
    };
  }, [containerId, symbol]);

  return <div id={containerId} className="tradingview-container" />;
}
