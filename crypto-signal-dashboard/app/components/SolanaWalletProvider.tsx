"use client";

import { clusterApiUrl, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from "react";

const LOCAL_WALLET_STORAGE_KEY = "brembot.local-wallet.secret.v1";

type AppWalletContextState = {
  connected: boolean;
  publicKey: PublicKey | null;
  hasWallet: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  createWallet: () => Promise<void>;
  importWallet: (secretInput: string) => Promise<void>;
  exportWallet: () => string | null;
};

type SolanaContextValue = {
  connection: Connection;
  wallet: AppWalletContextState;
};

const SolanaContext = createContext<SolanaContextValue | null>(null);

function toStoredSecret(secretKey: Uint8Array) {
  return JSON.stringify(Array.from(secretKey));
}

function parseStoredSecret(raw: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 64) return null;
    const bytes = Uint8Array.from(parsed.map((value) => Number(value)));
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

function parseImportedSecret(rawInput: string): Uint8Array | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  const fromJson = parseStoredSecret(trimmed);
  if (fromJson) return fromJson;

  const commaSeparated = trimmed.split(",").map((piece) => Number(piece.trim()));
  if (commaSeparated.length === 64 && commaSeparated.every((value) => Number.isFinite(value))) {
    return Uint8Array.from(commaSeparated);
  }

  return null;
}

export function SolanaWalletProvider({ children }: PropsWithChildren) {
  const [secretKey, setSecretKey] = useState<Uint8Array | null>(null);
  const [connected, setConnected] = useState(false);

  const envRpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  const rpcEndpoint = envRpc && /^https?:\/\//.test(envRpc) ? envRpc : clusterApiUrl("mainnet-beta");
  const connection = useMemo(() => new Connection(rpcEndpoint, "confirmed"), [rpcEndpoint]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(LOCAL_WALLET_STORAGE_KEY);
    if (!raw) return;
    const parsed = parseStoredSecret(raw);
    if (!parsed) return;
    setSecretKey(parsed);
    setConnected(true);
  }, []);

  const keypair = useMemo(() => {
    if (!secretKey) return null;
    try {
      return Keypair.fromSecretKey(secretKey);
    } catch {
      return null;
    }
  }, [secretKey]);

  useEffect(() => {
    if (secretKey && !keypair && typeof window !== "undefined") {
      window.localStorage.removeItem(LOCAL_WALLET_STORAGE_KEY);
      setSecretKey(null);
      setConnected(false);
    }
  }, [keypair, secretKey]);

  const wallet = useMemo<AppWalletContextState>(() => ({
    connected: connected && !!keypair,
    publicKey: connected && keypair ? keypair.publicKey : null,
    hasWallet: !!keypair,
    connect: async () => {
      if (keypair) setConnected(true);
    },
    disconnect: async () => {
      setConnected(false);
    },
    createWallet: async () => {
      const generated = Keypair.generate();
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_WALLET_STORAGE_KEY, toStoredSecret(generated.secretKey));
      }
      setSecretKey(generated.secretKey);
      setConnected(true);
    },
    importWallet: async (secretInput: string) => {
      const parsed = parseImportedSecret(secretInput);
      if (!parsed) throw new Error("Invalid secret key format");
      const imported = Keypair.fromSecretKey(parsed);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_WALLET_STORAGE_KEY, toStoredSecret(imported.secretKey));
      }
      setSecretKey(imported.secretKey);
      setConnected(true);
    },
    exportWallet: () => {
      if (!keypair) return null;
      return toStoredSecret(keypair.secretKey);
    },
  }), [connected, keypair]);

  return (
    <SolanaContext.Provider value={{ connection, wallet }}>
      {children}
    </SolanaContext.Provider>
  );
}

export function useConnection() {
  const context = useContext(SolanaContext);
  if (!context) {
    throw new Error("useConnection must be used within SolanaWalletProvider");
  }
  return { connection: context.connection };
}

export function useWallet() {
  const context = useContext(SolanaContext);
  if (!context) {
    throw new Error("useWallet must be used within SolanaWalletProvider");
  }
  return context.wallet;
}
