"use client";

import { PropsWithChildren, useMemo } from "react";
import { UnifiedWalletProvider } from "@jup-ag/wallet-adapter";

import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaWalletProvider({ children }: PropsWithChildren) {
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
      wallets={[]}
      config={{
        autoConnect: true,
        env: "mainnet-beta",
        metadata: walletMetadata,
        theme: "jupiter",
        hardcodedWallets: [],
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}
