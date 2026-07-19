"use client";

import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletConnectWalletAdapter } from "@solana/wallet-adapter-walletconnect";
import { VersionedTransaction } from "@solana/web3.js";

type NativeJupiterWalletState = {
  walletAddress: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  feedback: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  clearFeedback: () => void;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
};

const PENDING_CONNECT_STORAGE_KEY = "bremlogic.native.jupiter.pending-connect.v1";
const CONNECTED_SESSION_HINT_STORAGE_KEY = "bremlogic.native.jupiter.connected.v1";
const CONNECT_RESUME_MESSAGE = "Return to BremLogic after approval so the wallet session can finish attaching here.";
const CONNECT_TIMEOUT_MESSAGE = "Wallet connection timed out. Reopen your wallet and try again.";
const SIGN_TIMEOUT_MESSAGE = "Wallet approval timed out after 20 seconds. Retry the request if you still want to continue.";
const STALE_PENDING_MS = 20 * 1000;
const SIGN_TIMEOUT_MS = 20 * 1000;

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (/window closed/i.test(error.message)) {
      return "Wallet connection was closed before approval finished.";
    }

    if (/not ready/i.test(error.message)) {
      return "The wallet is not ready in this session yet. Close the wallet picker and try again.";
    }

    if (error.message.trim()) {
      return error.message;
    }
  }

  return "Wallet connection was not completed.";
}

function loadPendingConnectTimestamp(stalePendingMs = STALE_PENDING_MS) {
  if (typeof window === "undefined") return null;

  const rawValue = window.localStorage.getItem(PENDING_CONNECT_STORAGE_KEY);
  if (!rawValue) return null;

  const timestamp = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(timestamp)) {
    window.localStorage.removeItem(PENDING_CONNECT_STORAGE_KEY);
    return null;
  }

  if (Date.now() - timestamp > stalePendingMs) {
    window.localStorage.removeItem(PENDING_CONNECT_STORAGE_KEY);
    return null;
  }

  return timestamp;
}

function savePendingConnectTimestamp() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PENDING_CONNECT_STORAGE_KEY, String(Date.now()));
}

function clearPendingConnectTimestamp() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PENDING_CONNECT_STORAGE_KEY);
}

function loadConnectedSessionHint() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(CONNECTED_SESSION_HINT_STORAGE_KEY) === "true";
}

function saveConnectedSessionHint() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CONNECTED_SESSION_HINT_STORAGE_KEY, "true");
}

function clearConnectedSessionHint() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(CONNECTED_SESSION_HINT_STORAGE_KEY);
}

export function useNativeJupiterWalletConnect(
  enabled: boolean,
  reownProjectId: string,
  config?: { desktop?: boolean }
): NativeJupiterWalletState {
  const adapterRef = useRef<WalletConnectWalletAdapter | null>(null);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const pendingTimeoutRef = useRef<number | null>(null);
  const autoReconnectAttemptedRef = useRef(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const clearFeedback = useCallback(() => {
    setFeedback(null);
  }, []);

  const clearPendingTimeout = useCallback(() => {
    if (pendingTimeoutRef.current !== null) {
      window.clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
  }, []);

  const resetAdapter = useCallback(() => {
    adapterRef.current = null;
  }, []);

  const expirePendingConnect = useCallback((message = CONNECT_TIMEOUT_MESSAGE) => {
    clearPendingTimeout();
    clearPendingConnectTimestamp();
    connectPromiseRef.current = null;
    resetAdapter();
    setIsConnecting(false);
    setFeedback(message);
  }, [clearPendingTimeout, resetAdapter]);

  const schedulePendingTimeout = useCallback((timestamp: number) => {
    clearPendingTimeout();

    const timeoutMs = config?.desktop ? 120 * 1000 : STALE_PENDING_MS;
    const remainingMs = timeoutMs - (Date.now() - timestamp);
    if (remainingMs <= 0) {
      expirePendingConnect();
      return;
    }

    pendingTimeoutRef.current = window.setTimeout(() => {
      expirePendingConnect();
    }, remainingMs);
  }, [clearPendingTimeout, config?.desktop, expirePendingConnect]);

  const ensureAdapter = useCallback(() => {
    if (!enabled || !reownProjectId.trim()) return null;

    if (!adapterRef.current) {
      // This native-only path uses WalletConnect/AppKit directly instead of the thin Jupiter
      // wrapper so the Capacitor shell can manage the return-to-app lifecycle more predictably.
      adapterRef.current = new WalletConnectWalletAdapter({
        network: WalletAdapterNetwork.Mainnet,
        options: {
          projectId: reownProjectId.trim(),
          metadata: {
            name: "BremLogic",
            description: "BremLogic Signals Bot read-only Jupiter Perps wallet connection",
            url: "https://app.bremlogic.com",
            icons: ["https://app.bremlogic.com/favicon.ico"],
          },
        },
      });
    }

    return adapterRef.current;
  }, [enabled, reownProjectId]);

  const syncStateFromAdapter = useCallback(() => {
    const adapter = adapterRef.current;
    const publicKey = adapter?.publicKey?.toBase58() ?? null;
    setWalletAddress(publicKey);
    setIsConnected(Boolean(publicKey));

    if (publicKey) {
      clearPendingTimeout();
      clearPendingConnectTimestamp();
      saveConnectedSessionHint();
      setIsConnecting(false);
      setFeedback(null);
    }
  }, [clearPendingTimeout]);

  const connectWithAdapter = useCallback(async (
    adapter: WalletConnectWalletAdapter,
    options?: { isAutoReconnect?: boolean; setPendingState?: boolean }
  ) => {
    const isAutoReconnect = options?.isAutoReconnect ?? false;
    const setPendingState = options?.setPendingState ?? false;

    if (connectPromiseRef.current) {
      await connectPromiseRef.current;
      return;
    }

    if (setPendingState) {
      setIsConnecting(true);
      setFeedback(config?.desktop ? "Opening WalletConnect..." : "Opening Jupiter Mobile...");
      savePendingConnectTimestamp();
      schedulePendingTimeout(Date.now());
    } else if (isAutoReconnect) {
      setIsConnecting(true);
    }

    const connectPromise = (async () => {
      try {
        await adapter.connect();
        syncStateFromAdapter();

        if (!adapter.publicKey && setPendingState) {
          setFeedback(CONNECT_RESUME_MESSAGE);
        }
      } catch (error) {
        if (isAutoReconnect) {
          clearConnectedSessionHint();
          setIsConnecting(false);
        } else {
          expirePendingConnect(getFriendlyErrorMessage(error));
        }
        throw error;
      } finally {
        connectPromiseRef.current = null;
      }
    })();

    connectPromiseRef.current = connectPromise;
    await connectPromise;
  }, [config?.desktop, expirePendingConnect, schedulePendingTimeout, syncStateFromAdapter]);

  const connect = useCallback(async () => {
    const nextAdapter = ensureAdapter();
    if (!nextAdapter) {
      setFeedback("WalletConnect is not configured for this app yet. Add NEXT_PUBLIC_REOWN_PROJECT_ID to enable wallet connections.");
      return;
    }

    await connectWithAdapter(nextAdapter, { setPendingState: true });
  }, [connectWithAdapter, ensureAdapter]);

  const disconnect = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter) {
      clearPendingTimeout();
      setWalletAddress(null);
      setIsConnected(false);
      setIsConnecting(false);
      clearPendingConnectTimestamp();
      clearConnectedSessionHint();
      return;
    }

    setIsDisconnecting(true);

    try {
      await adapter.disconnect();
      clearPendingTimeout();
      clearPendingConnectTimestamp();
      clearConnectedSessionHint();
      connectPromiseRef.current = null;
      resetAdapter();
      setWalletAddress(null);
      setIsConnected(false);
      setIsConnecting(false);
      setFeedback("Wallet disconnected.");
    } catch (error) {
      setFeedback(getFriendlyErrorMessage(error));
      throw error;
    } finally {
      setIsDisconnecting(false);
    }
  }, [clearPendingTimeout, resetAdapter]);

  const signTransaction = useCallback(async (transaction: VersionedTransaction) => {
    const adapter = adapterRef.current;
    if (!adapter || !adapter.connected || !adapter.publicKey) {
      throw new Error("WalletConnect is not connected.");
    }

    if (typeof adapter.signTransaction !== "function") {
      throw new Error("The connected wallet session does not expose transaction signing.");
    }

    let timeoutId = 0;

    try {
      return await Promise.race([
        adapter.signTransaction(transaction),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            setFeedback(SIGN_TIMEOUT_MESSAGE);
            reject(new Error(SIGN_TIMEOUT_MESSAGE));
          }, SIGN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      clearPendingTimeout();
      clearPendingConnectTimestamp();
      setWalletAddress(null);
      setIsConnected(false);
      setIsConnecting(false);
      setIsDisconnecting(false);
      setFeedback(null);
      resetAdapter();
      connectPromiseRef.current = null;
      autoReconnectAttemptedRef.current = false;
      return;
    }

    const adapter = ensureAdapter();
    syncStateFromAdapter();

    const stalePendingMs = config?.desktop ? 120 * 1000 : STALE_PENDING_MS;
    const pendingConnectTimestamp = loadPendingConnectTimestamp(stalePendingMs);
    const hasConnectedSessionHint = loadConnectedSessionHint();
    if (pendingConnectTimestamp) {
      setFeedback(CONNECT_RESUME_MESSAGE);
      setIsConnecting(true);
      schedulePendingTimeout(pendingConnectTimestamp);
    }

    let cancelled = false;
    let removeResumeListener: (() => void) | undefined;

    async function registerNativeListeners() {
      if (!adapter) {
        return;
      }

      const handleConnect = () => {
        syncStateFromAdapter();
      };
      const handleDisconnect = () => {
        clearPendingTimeout();
        clearPendingConnectTimestamp();
        clearConnectedSessionHint();
        setWalletAddress(null);
        setIsConnected(false);
        setIsConnecting(false);
      };
      const handleError = (error: unknown) => {
        setFeedback(getFriendlyErrorMessage(error));
      };

      adapter.on("connect", handleConnect);
      adapter.on("disconnect", handleDisconnect);
      adapter.on("error", handleError);

      let resumeHandle: Awaited<ReturnType<typeof App.addListener>> | undefined;
      let appUrlOpenHandle: Awaited<ReturnType<typeof App.addListener>> | undefined;

      if (Capacitor.isNativePlatform()) {
        resumeHandle = await App.addListener("resume", () => {
          if (cancelled) return;
          syncStateFromAdapter();

          const pendingTimestamp = loadPendingConnectTimestamp(stalePendingMs);
          if (pendingTimestamp && !adapterRef.current?.publicKey) {
            setFeedback(CONNECT_RESUME_MESSAGE);
            setIsConnecting(true);
            schedulePendingTimeout(pendingTimestamp);
          } else if (!pendingTimestamp) {
            clearPendingTimeout();
            setIsConnecting(false);
          }
        });

        appUrlOpenHandle = await App.addListener("appUrlOpen", () => {
          if (cancelled) return;
          syncStateFromAdapter();

          const pendingTimestamp = loadPendingConnectTimestamp(stalePendingMs);
          if (pendingTimestamp && !adapterRef.current?.publicKey && !connectPromiseRef.current) {
            void connectWithAdapter(adapter, {
              isAutoReconnect: true,
              setPendingState: false,
            }).catch(() => undefined);
          }
        });
      }

      removeResumeListener = () => {
        adapter.off("connect", handleConnect);
        adapter.off("disconnect", handleDisconnect);
        adapter.off("error", handleError);
        void resumeHandle?.remove();
        void appUrlOpenHandle?.remove();
      };
    }

    void registerNativeListeners();

    if ((pendingConnectTimestamp || hasConnectedSessionHint) && adapter && !autoReconnectAttemptedRef.current) {
      autoReconnectAttemptedRef.current = true;
      void connectWithAdapter(adapter, {
        isAutoReconnect: true,
        setPendingState: false,
      }).catch(() => undefined);
    }

    return () => {
      cancelled = true;
      clearPendingTimeout();
      removeResumeListener?.();
    };
  }, [clearPendingTimeout, config?.desktop, connectWithAdapter, enabled, ensureAdapter, resetAdapter, schedulePendingTimeout, syncStateFromAdapter]);

  return {
    walletAddress,
    isConnected,
    isConnecting,
    isDisconnecting,
    feedback,
    connect,
    disconnect,
    clearFeedback,
    signTransaction,
  };
}
