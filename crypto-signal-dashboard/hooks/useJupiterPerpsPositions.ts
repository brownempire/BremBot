"use client";

import { useCallback, useEffect, useState } from "react";

import {
  getMockJupiterPerpsPendingTriggers,
  getMockJupiterPerpsPositions,
  type JupiterPerpsPendingTrigger,
  type JupiterPerpsPosition,
} from "@/lib/jupiterPerps";

type UseJupiterPerpsPositionsOptions = {
  walletAddress: string | null;
  showMockData: boolean;
};

type JupiterPerpsPositionsState = {
  positions: JupiterPerpsPosition[];
  pendingTriggers: JupiterPerpsPendingTrigger[];
  isLoading: boolean;
  error: string | null;
  isMock: boolean;
  refetch: () => Promise<void>;
};

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    if (/Discriminant\s+\d+\s+out of range/i.test(error.message) || /out of range for \d+ variants/i.test(error.message)) {
      return "Jupiter's beta Portfolio API could not decode this wallet's Perps positions right now. Live Perps data is temporarily unavailable for this wallet.";
    }

    return error.message;
  }

  if (typeof error === "string") {
    if (/Discriminant\s+\d+\s+out of range/i.test(error) || /out of range for \d+ variants/i.test(error)) {
      return "Jupiter's beta Portfolio API could not decode this wallet's Perps positions right now. Live Perps data is temporarily unavailable for this wallet.";
    }

    return error;
  }

  return "Unable to load Jupiter Perps positions right now.";
}

async function fetchPerpsSnapshotFromApi(walletAddress: string) {
  const response = await fetch(`/api/jupiter/perps?wallet=${encodeURIComponent(walletAddress)}`, {
    cache: "no-store",
  });

  const payload = (await response.json()) as
    | { positions: JupiterPerpsPosition[]; pendingTriggers: JupiterPerpsPendingTrigger[] }
    | { error?: string };

  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : "Unable to load Jupiter Perps positions right now.");
  }

  if (!("positions" in payload) || !("pendingTriggers" in payload)) {
    throw new Error("Invalid Jupiter Perps response.");
  }

  return payload;
}

export function useJupiterPerpsPositions({
  walletAddress,
  showMockData,
}: UseJupiterPerpsPositionsOptions): JupiterPerpsPositionsState {
  const [positions, setPositions] = useState<JupiterPerpsPosition[]>([]);
  const [pendingTriggers, setPendingTriggers] = useState<JupiterPerpsPendingTrigger[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  const loadPositions = useCallback(async () => {
    if (!walletAddress) {
      setError(null);
      setIsLoading(false);
      setIsMock(showMockData);
      setPositions(showMockData ? getMockJupiterPerpsPositions() : []);
      setPendingTriggers(showMockData ? getMockJupiterPerpsPendingTriggers() : []);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const next = await fetchPerpsSnapshotFromApi(walletAddress);
      setPositions(next.positions);
      setPendingTriggers(next.pendingTriggers);
      setIsMock(false);
    } catch (loadError) {
      const friendlyError = getFriendlyErrorMessage(loadError);
      setError(friendlyError);
      if (showMockData) {
        setPositions(getMockJupiterPerpsPositions());
        setPendingTriggers(getMockJupiterPerpsPendingTriggers());
        setIsMock(true);
      } else {
        setPositions([]);
        setPendingTriggers([]);
        setIsMock(false);
      }
    } finally {
      setIsLoading(false);
    }
  }, [showMockData, walletAddress]);

  useEffect(() => {
    void loadPositions();
  }, [loadPositions]);

  return {
    positions,
    pendingTriggers,
    isLoading,
    error,
    isMock,
    refetch: loadPositions,
  };
}
