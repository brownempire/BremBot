"use client";

import { useCallback, useEffect, useState } from "react";

import {
  fetchJupiterPerpsPositions,
  getMockJupiterPerpsPositions,
  type JupiterPerpsPosition,
} from "@/lib/jupiterPerps";

type UseJupiterPerpsPositionsOptions = {
  walletAddress: string | null;
  showMockData: boolean;
};

type JupiterPerpsPositionsState = {
  positions: JupiterPerpsPosition[];
  isLoading: boolean;
  error: string | null;
  isMock: boolean;
  refetch: () => Promise<void>;
};

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to load Jupiter Perps positions right now.";
}

export function useJupiterPerpsPositions({
  walletAddress,
  showMockData,
}: UseJupiterPerpsPositionsOptions): JupiterPerpsPositionsState {
  const [positions, setPositions] = useState<JupiterPerpsPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  const loadPositions = useCallback(async () => {
    if (!walletAddress) {
      setError(null);
      setIsLoading(false);
      setIsMock(showMockData);
      setPositions(showMockData ? getMockJupiterPerpsPositions() : []);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const next = await fetchJupiterPerpsPositions(walletAddress);
      setPositions(next);
      setIsMock(false);
    } catch (loadError) {
      const friendlyError = getFriendlyErrorMessage(loadError);
      setError(friendlyError);
      if (showMockData) {
        setPositions(getMockJupiterPerpsPositions());
        setIsMock(true);
      } else {
        setPositions([]);
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
    isLoading,
    error,
    isMock,
    refetch: loadPositions,
  };
}
