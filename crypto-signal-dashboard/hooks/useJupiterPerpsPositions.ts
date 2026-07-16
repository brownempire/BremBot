"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getMockJupiterPerpsPendingTriggers,
  getMockJupiterPerpsPositions,
  type JupiterPerpsTrade,
  type JupiterPerpsPendingTrigger,
  type JupiterPerpsPosition,
} from "@/lib/jupiterPerps";

type UseJupiterPerpsPositionsOptions = {
  authToken?: string | null;
  walletAddress: string | null;
  showMockData: boolean;
  pollingEnabled?: boolean;
};

type JupiterPerpsPositionsState = {
  agentAvailableUsdc: number | null;
  positions: JupiterPerpsPosition[];
  pendingTriggers: JupiterPerpsPendingTrigger[];
  recentTrades: JupiterPerpsTrade[];
  isLoading: boolean;
  error: string | null;
  isMock: boolean;
  refetch: () => Promise<void>;
};

const LIVE_PERPS_REFRESH_MS = 20_000;
const PERPS_ERROR_AUTO_CLEAR_MS = 20_000;

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    if (/Discriminant\s+\d+\s+out of range/i.test(error.message) || /out of range for \d+ variants/i.test(error.message)) {
      return "Jupiter's legacy fallback decoder could not parse this wallet's Perps accounts right now.";
    }

    return error.message;
  }

  if (typeof error === "string") {
    if (/Discriminant\s+\d+\s+out of range/i.test(error) || /out of range for \d+ variants/i.test(error)) {
      return "Jupiter's legacy fallback decoder could not parse this wallet's Perps accounts right now.";
    }

    return error;
  }

  return "Unable to load Jupiter Perps positions right now.";
}

async function fetchPerpsSnapshotFromApi(walletAddress: string, authToken?: string | null) {
  const response = await fetch(
    authToken ? "/api/perps/portfolio" : `/api/jupiter/perps?wallet=${encodeURIComponent(walletAddress)}`,
    {
    cache: "no-store",
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    }
  );

  const payload = (await response.json()) as
    | { positions: JupiterPerpsPosition[]; pendingTriggers: JupiterPerpsPendingTrigger[]; recentTrades: JupiterPerpsTrade[]; agentAvailableUsdc?: number | null }
    | { error?: string };

  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : "Unable to load Jupiter Perps positions right now.");
  }

  if (!("positions" in payload) || !("pendingTriggers" in payload) || !("recentTrades" in payload)) {
    throw new Error("Invalid Jupiter Perps response.");
  }

  return payload;
}

export function useJupiterPerpsPositions({
  authToken,
  walletAddress,
  showMockData,
  pollingEnabled = true,
}: UseJupiterPerpsPositionsOptions): JupiterPerpsPositionsState {
  const [positions, setPositions] = useState<JupiterPerpsPosition[]>([]);
  const [agentAvailableUsdc, setAgentAvailableUsdc] = useState<number | null>(null);
  const [pendingTriggers, setPendingTriggers] = useState<JupiterPerpsPendingTrigger[]>([]);
  const [recentTrades, setRecentTrades] = useState<JupiterPerpsTrade[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);
  const hasResolvedInitialLoadRef = useRef(false);
  const activeRequestRef = useRef<Promise<void> | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearErrorTimeout = useCallback(() => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => {
    clearErrorTimeout();
    setError(null);
  }, [clearErrorTimeout]);

  const setTimedError = useCallback((message: string) => {
    clearErrorTimeout();
    setError(message);
    errorTimeoutRef.current = setTimeout(() => {
      setError(null);
      errorTimeoutRef.current = null;
    }, PERPS_ERROR_AUTO_CLEAR_MS);
  }, [clearErrorTimeout]);

  const loadPositions = useCallback(async (options?: { silent?: boolean }) => {
    if (activeRequestRef.current) {
      await activeRequestRef.current;
      return;
    }

    const silent = options?.silent ?? false;

    if (!walletAddress) {
      hasResolvedInitialLoadRef.current = true;
      clearError();
      setIsLoading(false);
      setIsMock(showMockData);
      setPositions(showMockData ? getMockJupiterPerpsPositions() : []);
      setAgentAvailableUsdc(null);
      setPendingTriggers(showMockData ? getMockJupiterPerpsPendingTriggers() : []);
      setRecentTrades([]);
      return;
    }

    const shouldShowLoading = !silent && !hasResolvedInitialLoadRef.current;
    if (shouldShowLoading) {
      setIsLoading(true);
    }
    if (!silent) {
      clearError();
    }

    const request = (async () => {
      try {
        const next = await fetchPerpsSnapshotFromApi(walletAddress, authToken);
        hasResolvedInitialLoadRef.current = true;
        setPositions(next.positions);
        setAgentAvailableUsdc(next.agentAvailableUsdc ?? null);
        setPendingTriggers(next.pendingTriggers);
        setRecentTrades(next.recentTrades);
        setIsMock(false);
        clearError();
      } catch (loadError) {
        const friendlyError = getFriendlyErrorMessage(loadError);
        setTimedError(friendlyError);
        if (!silent) {
          if (showMockData) {
            setPositions(getMockJupiterPerpsPositions());
            setAgentAvailableUsdc(null);
            setPendingTriggers(getMockJupiterPerpsPendingTriggers());
            setRecentTrades([]);
            setIsMock(true);
            hasResolvedInitialLoadRef.current = true;
          } else {
            setPositions([]);
            setAgentAvailableUsdc(null);
            setPendingTriggers([]);
            setRecentTrades([]);
            setIsMock(false);
            hasResolvedInitialLoadRef.current = true;
          }
        }
      } finally {
        if (shouldShowLoading) {
          setIsLoading(false);
        }
        activeRequestRef.current = null;
      }
    })();

    activeRequestRef.current = request;
    await request;
  }, [authToken, clearError, setTimedError, showMockData, walletAddress]);

  useEffect(() => {
    hasResolvedInitialLoadRef.current = false;
    void loadPositions();
  }, [loadPositions]);

  useEffect(() => {
    if (!walletAddress || showMockData || !pollingEnabled) return;

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void loadPositions({ silent: true });
    }, LIVE_PERPS_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadPositions, pollingEnabled, showMockData, walletAddress]);

  useEffect(() => {
    return () => {
      clearErrorTimeout();
    };
  }, [clearErrorTimeout]);

  return {
    agentAvailableUsdc,
    positions,
    pendingTriggers,
    recentTrades,
    isLoading,
    error,
    isMock,
    refetch: loadPositions,
  };
}
