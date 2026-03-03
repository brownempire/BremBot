"use client";

import { PropsWithChildren, useMemo } from "react";
import { HARDCODED_WALLET_STANDARDS, UnifiedWalletProvider } from "@jup-ag/wallet-adapter";

import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaWalletProvider({ children }: PropsWithChildren) {
  const hardcodedWallets = useMemo(() => {
    const jupiterWallet = {
      id: "Jupiter Wallet",
      name: "Jupiter Wallet",
      url: "https://jup.ag",
      icon: "https://jup.ag/favicon.ico",
    };

    return [jupiterWallet, ...HARDCODED_WALLET_STANDARDS];
  }, []);

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
        walletPrecedence: ["Jupiter Wallet", "Phantom"],
        hardcodedWallets,
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}
