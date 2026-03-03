"use client";

import { PropsWithChildren, useMemo } from "react";
import { HARDCODED_WALLET_STANDARDS, UnifiedWalletProvider } from "@jup-ag/wallet-adapter";
import type { WalletName } from "@solana/wallet-adapter-base";

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
    const jupiterWallet = HARDCODED_WALLET_STANDARDS.find((wallet) => wallet.id === "Jupiter Mobile");
    if (!jupiterWallet) return HARDCODED_WALLET_STANDARDS;
    return [jupiterWallet, ...HARDCODED_WALLET_STANDARDS.filter((wallet) => wallet.id !== "Jupiter Mobile")];
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
        walletPrecedence: ["Jupiter Wallet" as WalletName],
        hardcodedWallets,
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}
