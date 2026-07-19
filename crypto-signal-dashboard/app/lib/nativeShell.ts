const NATIVE_SHELL_STORAGE_KEY = "bremlogic.native-shell.runtime.v1";

function readNativeShellHint() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const url = new URL(window.location.href);
    const nativeShellParam = url.searchParams.get("nativeShell");
    if (nativeShellParam === "ios" || nativeShellParam === "true" || nativeShellParam === "1") {
      window.sessionStorage.setItem(NATIVE_SHELL_STORAGE_KEY, "true");
      window.localStorage.removeItem(NATIVE_SHELL_STORAGE_KEY);
      return true;
    }

    if (nativeShellParam === "false" || nativeShellParam === "0") {
      window.sessionStorage.removeItem(NATIVE_SHELL_STORAGE_KEY);
      window.localStorage.removeItem(NATIVE_SHELL_STORAGE_KEY);
      return false;
    }

    return window.sessionStorage.getItem(NATIVE_SHELL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function isNativeShellRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  const runtimeWindow = window as Window & {
    Capacitor?: {
      isNativePlatform?: () => boolean;
    };
    webkit?: {
      messageHandlers?: {
        bridge?: unknown;
        capacitor?: unknown;
      };
    };
  };
  const userAgent = window.navigator.userAgent || "";
  const hasCapacitorBridge = Boolean(
    runtimeWindow.Capacitor?.isNativePlatform?.()
    || (runtimeWindow.webkit
      && runtimeWindow.webkit.messageHandlers
      && (runtimeWindow.webkit.messageHandlers.bridge || runtimeWindow.webkit.messageHandlers.capacitor))
  );

  return hasCapacitorBridge || /BremLogicNative|Capacitor/i.test(userAgent) || readNativeShellHint();
}

export function isNativeIosRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  return isNativeShellRuntime() && /iPhone|iPad|iPod/i.test(window.navigator.userAgent || "");
}

export function isNativeMacRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  return /BremLogicMac\//i.test(window.navigator.userAgent || "");
}

export function isStandalonePwaRuntime() {
  if (typeof window === "undefined") {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & {
    standalone?: boolean;
  };

  return Boolean(
    window.matchMedia?.("(display-mode: standalone)").matches
      || navigatorWithStandalone.standalone
  );
}
