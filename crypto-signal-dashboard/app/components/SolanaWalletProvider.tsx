"use client";

import { PropsWithChildren, useMemo } from "react";
import { clusterApiUrl } from "@solana/web3.js";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { UnifiedWalletProvider } from "@jup-ag/wallet-adapter";

import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaWalletProvider({ children }: PropsWithChildren) {
  const endpoint = useMemo(
    () => process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"),
    []
  );

  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  const walletMetadata = useMemo(
    () => ({
      name: "BremLogic",
      description: "BremLogic wallet connection",
      url: "https://www.bremlogic.com",
      iconUrls: ["https://www.bremlogic.com/icon-192.png"],
    }),
    []
  );

  return (
    <UnifiedWalletProvider
      wallets={wallets}
      config={{
        autoConnect: true,
        env: "mainnet-beta",
        metadata: walletMetadata,
        theme: "jupiter",
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}
