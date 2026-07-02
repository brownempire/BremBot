"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import bs58 from "bs58";
import nacl from "tweetnacl";

type PhantomBrowserSdkWalletState = {
  canUseInAppApproval: boolean;
  isMobile: boolean;
  isConfigured: boolean;
  isReady: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isConnected: boolean;
  walletAddress: string | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

type PendingPhantomConnect = {
  createdAt: number;
  dappEncryptionPublicKey: string;
  dappEncryptionSecretKey: string;
};

type StoredPhantomSession = {
  connectedAt: number;
  session: string;
  walletAddress: string;
};

type PhantomConnectPayload = {
  public_key: string;
  session: string;
};

const MOBILE_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod/i;
const PHANTOM_CONNECT_URL = "https://phantom.app/ul/v1/connect";
const PENDING_CONNECT_STORAGE_KEY = "bremlogic.phantom.pending-connect.v1";
const SESSION_STORAGE_KEY = "bremlogic.phantom.session.v1";
const CALLBACK_PARAM = "phantom_callback";
const CONNECT_CALLBACK = "connect";
const NATIVE_PHANTOM_REDIRECT_URL = "bremlogic://phantom/connect";

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to complete Phantom wallet connection right now.";
}

function serializeCurrentUrl() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.hash = "";
  return url.toString();
}

function isNativeShell() {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}

function getRedirectUrl() {
  const configured = process.env.NEXT_PUBLIC_PHANTOM_REDIRECT_URL?.trim();
  if (configured) return configured;

  if (isNativeShell()) return NATIVE_PHANTOM_REDIRECT_URL;

  if (typeof window === "undefined") return "";

  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.set(CALLBACK_PARAM, CONNECT_CALLBACK);
  return url.toString();
}

function buildConnectUrl(dappEncryptionPublicKey: string) {
  const params = new URLSearchParams({
    app_url: typeof window === "undefined" ? "https://www.bremlogic.com" : window.location.origin,
    dapp_encryption_public_key: dappEncryptionPublicKey,
    redirect_link: getRedirectUrl(),
    cluster: "mainnet-beta",
  });

  return `${PHANTOM_CONNECT_URL}?${params.toString()}`;
}

function savePendingConnect(value: PendingPhantomConnect) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PENDING_CONNECT_STORAGE_KEY, JSON.stringify(value));
}

function loadPendingConnect() {
  if (typeof window === "undefined") return null;

  const raw = window.localStorage.getItem(PENDING_CONNECT_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingPhantomConnect;
    if (!parsed?.dappEncryptionPublicKey || !parsed?.dappEncryptionSecretKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearPendingConnect() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PENDING_CONNECT_STORAGE_KEY);
}

function saveStoredSession(value: StoredPhantomSession) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
}

function loadStoredSession() {
  if (typeof window === "undefined") return null;

  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredPhantomSession;
    if (!parsed?.walletAddress || !parsed?.session) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearStoredSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

function decodeConnectPayload(
  data: string,
  nonce: string,
  phantomEncryptionPublicKey: string,
  dappEncryptionSecretKey: string
) {
  const sharedSecret = nacl.box.before(
    bs58.decode(phantomEncryptionPublicKey),
    bs58.decode(dappEncryptionSecretKey)
  );

  const decrypted = nacl.box.open.after(bs58.decode(data), bs58.decode(nonce), sharedSecret);

  if (!decrypted) {
    throw new Error("Phantom returned an unreadable connection payload.");
  }

  return JSON.parse(new TextDecoder().decode(decrypted)) as PhantomConnectPayload;
}

function stripPhantomParamsFromUrl(urlString?: string) {
  if (typeof window === "undefined") return "";

  const currentUrl = new URL(urlString ?? window.location.href);
  currentUrl.searchParams.delete(CALLBACK_PARAM);
  currentUrl.searchParams.delete("phantom_encryption_public_key");
  currentUrl.searchParams.delete("nonce");
  currentUrl.searchParams.delete("data");
  currentUrl.searchParams.delete("errorCode");
  currentUrl.searchParams.delete("errorMessage");
  currentUrl.hash = "";

  const cleanedUrl = currentUrl.toString();
  if (!urlString) {
    window.history.replaceState({}, "", cleanedUrl);
  }
  return cleanedUrl;
}

function normalizeCallbackUrl(urlString: string) {
  if (typeof window === "undefined") return urlString;

  const callbackUrl = new URL(urlString);
  if (callbackUrl.protocol.startsWith("http")) return callbackUrl.toString();

  const browserUrl = new URL(window.location.href);
  browserUrl.search = callbackUrl.search;
  browserUrl.hash = "";
  return browserUrl.toString();
}

function processConnectCallback(urlString: string) {
  const currentUrl = new URL(normalizeCallbackUrl(urlString));
  const pendingConnect = loadPendingConnect();

  try {
    if (!pendingConnect) {
      throw new Error("Phantom returned to BremLogic, but the connection session could not be resumed.");
    }

    const errorCode = currentUrl.searchParams.get("errorCode");
    const errorMessage = currentUrl.searchParams.get("errorMessage");

    if (errorCode) {
      throw new Error(errorMessage || "Wallet connection was not approved.");
    }

    const phantomEncryptionPublicKey = currentUrl.searchParams.get("phantom_encryption_public_key");
    const nonce = currentUrl.searchParams.get("nonce");
    const data = currentUrl.searchParams.get("data");

    if (!phantomEncryptionPublicKey || !nonce || !data) {
      throw new Error("Phantom returned an incomplete connection response.");
    }

    const payload = decodeConnectPayload(
      data,
      nonce,
      phantomEncryptionPublicKey,
      pendingConnect.dappEncryptionSecretKey
    );

    saveStoredSession({
      connectedAt: Date.now(),
      session: payload.session,
      walletAddress: payload.public_key,
    });

    clearPendingConnect();
    stripPhantomParamsFromUrl(currentUrl.toString());

    return {
      walletAddress: payload.public_key,
      error: null,
    };
  } catch (callbackError) {
    clearStoredSession();
    clearPendingConnect();
    stripPhantomParamsFromUrl(currentUrl.toString());

    return {
      walletAddress: null,
      error: getFriendlyErrorMessage(callbackError),
    };
  }
}

export function usePhantomBrowserSdkWallet(): PhantomBrowserSdkWalletState {
  const [isMobile, setIsMobile] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canUseInAppApproval = useMemo(() => isMobile, [isMobile]);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setIsMobile(MOBILE_USER_AGENT_PATTERN.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const storedSession = loadStoredSession();
    if (storedSession) {
      setIsConnected(true);
      setWalletAddress(storedSession.walletAddress);
    }

    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get(CALLBACK_PARAM) === CONNECT_CALLBACK) {
      const callbackResult = processConnectCallback(currentUrl.toString());
      setIsConnected(Boolean(callbackResult.walletAddress));
      setWalletAddress(callbackResult.walletAddress);
      setError(callbackResult.error);
    }

    let cancelled = false;
    let removeListener: (() => void) | undefined;

    async function registerNativeCallbackListener() {
      if (!isNativeShell()) {
        if (!cancelled) setIsReady(true);
        return;
      }

      const handle = await App.addListener("appUrlOpen", ({ url }) => {
        if (!url.includes(CALLBACK_PARAM) || !url.includes(CONNECT_CALLBACK)) return;
        const callbackResult = processConnectCallback(url);
        setIsConnected(Boolean(callbackResult.walletAddress));
        setWalletAddress(callbackResult.walletAddress);
        setError(callbackResult.error);
        setIsConnecting(false);
      });

      removeListener = () => {
        void handle.remove();
      };

      if (!cancelled) setIsReady(true);
    }

    void registerNativeCallbackListener();

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, []);

  const connect = useCallback(async () => {
    if (!canUseInAppApproval) {
      setError("Phantom mobile approval is only available on supported mobile devices.");
      return;
    }

    if (typeof window === "undefined") return;

    setIsConnecting(true);
    setError(null);

    try {
      const dappKeyPair = nacl.box.keyPair();
      savePendingConnect({
        createdAt: Date.now(),
        dappEncryptionPublicKey: bs58.encode(dappKeyPair.publicKey),
        dappEncryptionSecretKey: bs58.encode(dappKeyPair.secretKey),
      });

      window.location.assign(buildConnectUrl(bs58.encode(dappKeyPair.publicKey)));
    } catch (connectError) {
      clearPendingConnect();
      setError(getFriendlyErrorMessage(connectError));
      setIsConnecting(false);
      throw connectError;
    }
  }, [canUseInAppApproval]);

  const disconnect = useCallback(async () => {
    setIsDisconnecting(true);
    try {
      clearPendingConnect();
      clearStoredSession();
      setIsConnected(false);
      setWalletAddress(null);
      setError(null);
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", serializeCurrentUrl());
      }
    } finally {
      setIsDisconnecting(false);
    }
  }, []);

  return {
    canUseInAppApproval,
    isMobile,
    isConfigured: true,
    isReady,
    isConnecting,
    isDisconnecting,
    isConnected,
    walletAddress,
    error,
    connect,
    disconnect,
  };
}
