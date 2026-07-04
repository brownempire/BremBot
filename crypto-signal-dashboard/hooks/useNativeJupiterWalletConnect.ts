"use client";

import { App } from "@capacitor/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { WalletConnectWalletAdapter } from "@solana/wallet-adapter-walletconnect";

type NativeJupiterWalletState = {
  walletAddress: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  feedback: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  clearFeedback: () => void;
};

const PENDING_CONNECT_STORAGE_KEY = "bremlogic.native.jupiter.pending-connect.v1";
const CONNECT_STARTED_MESSAGE = "Opening Jupiter Mobile...";
const CONNECT_RESUME_MESSAGE = "Return to BremLogic after approval so the wallet session can finish attaching here.";
const CONNECT_TIMEOUT_MESSAGE = "Jupiter Mobile connection timed out after 3 minutes. Reopen Jupiter Mobile and try again.";
const STALE_PENDING_MS = 3 * 60 * 1000;

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (/window closed/i.test(error.message)) {
      return "Jupiter Mobile connection was closed before approval finished.";
    }

    if (/not ready/i.test(error.message)) {
      return "Jupiter Mobile is not ready in this session yet. Close the wallet picker and try again.";
    }

    if (error.message.trim()) {
      return error.message;
    }
  }

  return "Jupiter Mobile connection was not completed.";
}

function loadPendingConnectTimestamp() {
  if (typeof window === "undefined") return null;

  const rawValue = window.localStorage.getItem(PENDING_CONNECT_STORAGE_KEY);
  if (!rawValue) return null;

  const timestamp = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(timestamp)) {
    window.localStorage.removeItem(PENDING_CONNECT_STORAGE_KEY);
    return null;
  }

  if (Date.now() - timestamp > STALE_PENDING_MS) {
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

export function useNativeJupiterWalletConnect(enabled: boolean, reownProjectId: string): NativeJupiterWalletState {
  const adapterRef = useRef<WalletConnectWalletAdapter | null>(null);
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  const pendingTimeoutRef = useRef<number | null>(null);
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

  const expirePendingConnect = useCallback((message = CONNECT_TIMEOUT_MESSAGE) => {
    clearPendingTimeout();
    clearPendingConnectTimestamp();
    connectPromiseRef.current = null;
    setIsConnecting(false);
    setFeedback(message);
  }, [clearPendingTimeout]);

  const schedulePendingTimeout = useCallback((timestamp: number) => {
    clearPendingTimeout();

    const remainingMs = STALE_PENDING_MS - (Date.now() - timestamp);
    if (remainingMs <= 0) {
      expirePendingConnect();
      return;
    }

    pendingTimeoutRef.current = window.setTimeout(() => {
      expirePendingConnect();
    }, remainingMs);
  }, [clearPendingTimeout, expirePendingConnect]);

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
      setIsConnecting(false);
      setFeedback(null);
    }
  }, [clearPendingTimeout]);

  const connect = useCallback(async () => {
    const adapter = ensureAdapter();
    if (!adapter) {
      setFeedback("Jupiter Mobile adapter is not configured for the native app yet. Add NEXT_PUBLIC_REOWN_PROJECT_ID to enable the native iOS flow.");
      return;
    }

    if (connectPromiseRef.current) {
      await connectPromiseRef.current;
      return;
    }

    setIsConnecting(true);
    setFeedback(CONNECT_STARTED_MESSAGE);
    savePendingConnectTimestamp();
    schedulePendingTimeout(Date.now());

    const connectPromise = (async () => {
      try {
        await adapter.connect();
        syncStateFromAdapter();

        if (!adapter.publicKey) {
          setFeedback(CONNECT_RESUME_MESSAGE);
        }
      } catch (error) {
        expirePendingConnect(getFriendlyErrorMessage(error));
        throw error;
      } finally {
        connectPromiseRef.current = null;
      }
    })();

    connectPromiseRef.current = connectPromise;
    await connectPromise;
  }, [ensureAdapter, expirePendingConnect, schedulePendingTimeout, syncStateFromAdapter]);

  const disconnect = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter) {
      clearPendingTimeout();
      setWalletAddress(null);
      setIsConnected(false);
      setIsConnecting(false);
      clearPendingConnectTimestamp();
      return;
    }

    setIsDisconnecting(true);

    try {
      await adapter.disconnect();
      clearPendingTimeout();
      clearPendingConnectTimestamp();
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
  }, [clearPendingTimeout]);

  useEffect(() => {
    if (!enabled) {
      clearPendingTimeout();
      clearPendingConnectTimestamp();
      setWalletAddress(null);
      setIsConnected(false);
      setIsConnecting(false);
      setIsDisconnecting(false);
      setFeedback(null);
      adapterRef.current = null;
      connectPromiseRef.current = null;
      return;
    }

    ensureAdapter();
    syncStateFromAdapter();

    const pendingConnectTimestamp = loadPendingConnectTimestamp();
    if (pendingConnectTimestamp) {
      setFeedback(CONNECT_RESUME_MESSAGE);
      setIsConnecting(true);
      schedulePendingTimeout(pendingConnectTimestamp);
    }

    let cancelled = false;
    let removeResumeListener: (() => void) | undefined;

    async function registerNativeListeners() {
      const resumeHandle = await App.addListener("resume", () => {
        if (cancelled) return;
        syncStateFromAdapter();

        const pendingTimestamp = loadPendingConnectTimestamp();
        if (pendingTimestamp && !adapterRef.current?.publicKey) {
          setFeedback(CONNECT_RESUME_MESSAGE);
          setIsConnecting(true);
          schedulePendingTimeout(pendingTimestamp);
        } else if (!pendingTimestamp) {
          clearPendingTimeout();
          setIsConnecting(false);
        }
      });

      removeResumeListener = () => {
        void resumeHandle.remove();
      };
    }

    void registerNativeListeners();

    return () => {
      cancelled = true;
      clearPendingTimeout();
      removeResumeListener?.();
    };
  }, [clearPendingTimeout, enabled, ensureAdapter, schedulePendingTimeout, syncStateFromAdapter]);

  return {
    walletAddress,
    isConnected,
    isConnecting,
    isDisconnecting,
    feedback,
    connect,
    disconnect,
    clearFeedback,
  };
}
