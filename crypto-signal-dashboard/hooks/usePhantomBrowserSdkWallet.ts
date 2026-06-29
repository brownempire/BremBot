"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type PhantomBrowserSdkModule = typeof import("@phantom/browser-sdk");
type PhantomBrowserSdk = InstanceType<PhantomBrowserSdkModule["BrowserSDK"]>;

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

type PhantomWalletAddress = {
  address: string;
  type?: string;
};

const MOBILE_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod/i;

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to complete Phantom wallet connection right now.";
}

function getSolanaAddress(addresses: PhantomWalletAddress[]) {
  const solanaAddress = addresses.find((item) => item.type === "solana");
  return solanaAddress?.address ?? null;
}

function getRedirectUrl() {
  const configured = process.env.NEXT_PUBLIC_PHANTOM_REDIRECT_URL?.trim();
  if (configured) return configured;
  if (typeof window !== "undefined") return window.location.href;
  return "";
}

export function usePhantomBrowserSdkWallet(): PhantomBrowserSdkWalletState {
  const [isMobile, setIsMobile] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sdkRef = useRef<PhantomBrowserSdk | null>(null);
  const appId = process.env.NEXT_PUBLIC_PHANTOM_APP_ID?.trim() ?? "";
  const isConfigured = appId.length > 0;

  const canUseInAppApproval = useMemo(() => isMobile && isConfigured, [isConfigured, isMobile]);

  const syncWalletState = useCallback((sdk: PhantomBrowserSdk | null) => {
    if (!sdk) {
      setIsConnected(false);
      setWalletAddress(null);
      return;
    }

    const connected = sdk.isConnected();
    const addresses = sdk.getAddresses() as PhantomWalletAddress[];
    setIsConnected(connected);
    setWalletAddress(connected ? getSolanaAddress(addresses) : null);
  }, []);

  const ensureSdk = useCallback(async () => {
    if (!canUseInAppApproval) return null;
    if (sdkRef.current) return sdkRef.current;

    const sdkModule = (await import("@phantom/browser-sdk")) as PhantomBrowserSdkModule;
    const sdk = new sdkModule.BrowserSDK({
      providers: ["deeplink"],
      addressTypes: [sdkModule.AddressType.solana],
      appId,
      embeddedWalletType: "user-wallet",
      authOptions: {
        // Returning to the current page keeps the user on BremLogic after approving in Phantom.
        redirectUrl: getRedirectUrl(),
      },
    });

    sdkRef.current = sdk;
    return sdk;
  }, [appId, canUseInAppApproval]);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setIsMobile(MOBILE_USER_AGENT_PATTERN.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!canUseInAppApproval) {
        setIsReady(false);
        syncWalletState(null);
        return;
      }

      try {
        const sdk = await ensureSdk();
        await sdk?.autoConnect();
        if (!cancelled) {
          syncWalletState(sdk);
          setError(null);
        }
      } catch (bootstrapError) {
        if (!cancelled) {
          setError(getFriendlyErrorMessage(bootstrapError));
          syncWalletState(null);
        }
      } finally {
        if (!cancelled) {
          setIsReady(true);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [canUseInAppApproval, ensureSdk, syncWalletState]);

  const connect = useCallback(async () => {
    if (!canUseInAppApproval) {
      setError("Phantom in-app mobile approval is not available on this device.");
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const sdk = await ensureSdk();
      if (!sdk) {
        throw new Error("Phantom mobile wallet is not ready yet.");
      }

      await sdk.connect({ provider: "deeplink" });
      syncWalletState(sdk);
    } catch (connectError) {
      setError(getFriendlyErrorMessage(connectError));
      syncWalletState(sdkRef.current);
      throw connectError;
    } finally {
      setIsConnecting(false);
    }
  }, [canUseInAppApproval, ensureSdk, syncWalletState]);

  const disconnect = useCallback(async () => {
    if (!sdkRef.current) {
      syncWalletState(null);
      return;
    }

    setIsDisconnecting(true);
    setError(null);

    try {
      await sdkRef.current.disconnect();
      syncWalletState(sdkRef.current);
    } catch (disconnectError) {
      setError(getFriendlyErrorMessage(disconnectError));
      throw disconnectError;
    } finally {
      setIsDisconnecting(false);
    }
  }, [syncWalletState]);

  return {
    canUseInAppApproval,
    isMobile,
    isConfigured,
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
