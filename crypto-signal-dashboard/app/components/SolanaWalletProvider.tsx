"use client";

import { PropsWithChildren, useMemo } from "react";
import { HARDCODED_WALLET_STANDARDS, UnifiedWalletProvider } from "@jup-ag/wallet-adapter";

import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaWalletProvider({ children }: PropsWithChildren) {
  const jupiterOnlyWallets = useMemo(() => {
    const jupiterWallet = HARDCODED_WALLET_STANDARDS.find((wallet) => wallet.id === "Jupiter Mobile");
    return jupiterWallet ? [jupiterWallet] : [];
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
        hardcodedWallets: jupiterOnlyWallets,
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}
