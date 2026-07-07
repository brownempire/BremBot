export function isNativeShellRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  const runtimeWindow = window as Window & {
    Capacitor?: unknown;
    webkit?: {
      messageHandlers?: {
        bridge?: unknown;
        capacitor?: unknown;
      };
    };
  };
  const userAgent = window.navigator.userAgent || "";
  const hasCapacitorBridge = Boolean(
    runtimeWindow.Capacitor
    || (runtimeWindow.webkit
      && runtimeWindow.webkit.messageHandlers
      && (runtimeWindow.webkit.messageHandlers.bridge || runtimeWindow.webkit.messageHandlers.capacitor))
  );

  return hasCapacitorBridge || /BremLogicNative|Capacitor/i.test(userAgent);
}

export function isNativeIosRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  return isNativeShellRuntime() && /iPhone|iPad|iPod/i.test(window.navigator.userAgent || "");
}
