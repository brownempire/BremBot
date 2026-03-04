"use client";

import { clusterApiUrl, Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from "react";
import bs58 from "bs58";

const LOCAL_WALLET_STORAGE_KEY = "brembot.local-wallet.encrypted.v2";
const DEFAULT_WALLET_PASSWORD = "bremlogic";
const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 16;
const PBKDF2_ITERATIONS = 210000;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";

type StoredWalletPayload = {
  version: 2;
  salt: string;
  iv: string;
  ciphertext: string;
  iterations: number;
};

type ExecuteSwapParams = {
  inputMint: string;
  outputMint: string;
  uiAmount: number;
  slippageBps?: number;
};

type ExecuteSwapResult = {
  txid: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount?: number;
};

type AppWalletContextState = {
  connected: boolean;
  publicKey: PublicKey | null;
  hasWallet: boolean;
  login: (password?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  createWallet: (password?: string) => Promise<void>;
  importWallet: (secretInput: string, password?: string) => Promise<void>;
  exportWallet: () => string | null;
  changePassword: (currentPassword: string, nextPassword: string) => Promise<void>;
  executeSwap: (params: ExecuteSwapParams) => Promise<ExecuteSwapResult>;
  passthroughWalletContextState: Record<string, unknown>;
};

type SolanaContextValue = {
  connection: Connection;
  wallet: AppWalletContextState;
};

const SolanaContext = createContext<SolanaContextValue | null>(null);

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(input: string) {
  const raw = atob(input);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function toStoredSecret(secretKey: Uint8Array) {
  return JSON.stringify(Array.from(secretKey));
}

function parseSecretArray(raw: string): Uint8Array | null {
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
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 64) return decoded;
    if (decoded.length === 32) return Keypair.fromSeed(decoded).secretKey;
    return null;
  } catch {
    return null;
  }
}

function normalizePassword(password?: string) {
  const value = (password ?? DEFAULT_WALLET_PASSWORD).trim();
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`);
  }
  return value;
}

async function deriveAesKey(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS) {
  const encoder = new TextEncoder();
  const passwordKey = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptSecret(secretKey: Uint8Array, password: string): Promise<StoredWalletPayload> {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(toStoredSecret(secretKey));
  const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return {
    version: 2,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iterations: PBKDF2_ITERATIONS,
  };
}

async function decryptSecret(payload: StoredWalletPayload, password: string): Promise<Uint8Array> {
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);
  const key = await deriveAesKey(password, salt, payload.iterations ?? PBKDF2_ITERATIONS);
  const plaintext = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const decoded = new TextDecoder().decode(plaintext);
  const parsed = parseSecretArray(decoded);
  if (!parsed) throw new Error("Invalid wallet payload");
  return parsed;
}

function loadStoredWalletPayload(): StoredWalletPayload | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LOCAL_WALLET_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredWalletPayload;
    if (!parsed?.salt || !parsed?.iv || !parsed?.ciphertext) return null;
    return parsed;
  } catch {
    return null;
  }
}

function mintDecimals(mint: string) {
  return mint === USDC_MINT ? 6 : mint === SOL_MINT ? 9 : 9;
}

function uiToAtomicAmount(uiAmount: number, decimals: number) {
  const safe = Number.isFinite(uiAmount) ? uiAmount : 0;
  const scaled = Math.floor(safe * (10 ** decimals));
  return scaled > 0 ? String(scaled) : "0";
}

export function SolanaWalletProvider({ children }: PropsWithChildren) {
  const [secretKey, setSecretKey] = useState<Uint8Array | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasStoredWallet, setHasStoredWallet] = useState(false);

  const envRpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  const rpcEndpoint = envRpc && /^https?:\/\//.test(envRpc) ? envRpc : clusterApiUrl("mainnet-beta");
  const connection = useMemo(() => new Connection(rpcEndpoint, "confirmed"), [rpcEndpoint]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = loadStoredWalletPayload();
    setHasStoredWallet(!!payload);
    if (!payload) return;
    decryptSecret(payload, DEFAULT_WALLET_PASSWORD)
      .then((decoded) => {
        setSecretKey(decoded);
        setConnected(true);
      })
      .catch(() => {
        setConnected(false);
      });
  }, []);

  const keypair = useMemo(() => {
    if (!secretKey) return null;
    try {
      return Keypair.fromSecretKey(secretKey);
    } catch {
      return null;
    }
  }, [secretKey]);

  const passthroughWalletContextState = useMemo<Record<string, unknown>>(() => {
    const adapter = keypair ? {
      name: "BremLogic In-App Wallet",
      url: "https://www.bremlogic.com",
      icon: "",
      publicKey: connected ? keypair.publicKey : null,
      connecting: false,
      connected: connected && !!keypair,
      disconnect: async () => {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LOCAL_WALLET_STORAGE_KEY);
        }
        setSecretKey(null);
        setConnected(false);
        setHasStoredWallet(false);
      },
      connect: async () => {
        if (keypair) setConnected(true);
      },
      sendTransaction: async (transaction: unknown, conn: Connection, options?: { skipPreflight?: boolean; maxRetries?: number }) => {
        if (!keypair) throw new Error("Wallet is not connected");
        if (transaction instanceof VersionedTransaction) {
          transaction.sign([keypair]);
          return conn.sendRawTransaction(transaction.serialize(), {
            skipPreflight: options?.skipPreflight ?? false,
            maxRetries: options?.maxRetries ?? 3,
          });
        }
        throw new Error("Unsupported transaction format");
      },
      signTransaction: async (transaction: unknown) => {
        if (!keypair) throw new Error("Wallet is not connected");
        if (transaction instanceof VersionedTransaction) {
          transaction.sign([keypair]);
          return transaction;
        }
        throw new Error("Unsupported transaction format");
      },
      signAllTransactions: async (transactions: unknown[]) => {
        if (!keypair) throw new Error("Wallet is not connected");
        return transactions.map((transaction) => {
          if (transaction instanceof VersionedTransaction) {
            transaction.sign([keypair]);
            return transaction;
          }
          throw new Error("Unsupported transaction format");
        });
      },
    } : null;

    const wallet = adapter ? { adapter, readyState: "Installed" } : null;
    return {
      publicKey: connected && keypair ? keypair.publicKey : null,
      wallets: wallet ? [wallet] : [],
      wallet,
      connect: async () => {
        if (keypair) setConnected(true);
      },
      select: () => undefined,
      connecting: false,
      connected: connected && !!keypair,
      disconnect: async () => {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LOCAL_WALLET_STORAGE_KEY);
        }
        setSecretKey(null);
        setConnected(false);
        setHasStoredWallet(false);
      },
      autoConnect: false,
      disconnecting: false,
      sendTransaction: adapter?.sendTransaction,
      signTransaction: adapter?.signTransaction,
      signAllTransactions: adapter?.signAllTransactions,
      signMessage: undefined,
      signIn: undefined,
    };
  }, [connected, keypair]);

  useEffect(() => {
    if (secretKey && !keypair) {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(LOCAL_WALLET_STORAGE_KEY);
      }
      setSecretKey(null);
      setConnected(false);
      setHasStoredWallet(false);
    }
  }, [keypair, secretKey]);

  const wallet = useMemo<AppWalletContextState>(() => ({
    connected: connected && !!keypair,
    publicKey: connected && keypair ? keypair.publicKey : null,
    hasWallet: hasStoredWallet || !!keypair,
    login: async (password?: string) => {
      const payload = loadStoredWalletPayload();
      if (!payload) throw new Error("No wallet found on this device");
      const normalized = normalizePassword(password);
      const decoded = await decryptSecret(payload, normalized);
      setSecretKey(decoded);
      setConnected(true);
      setHasStoredWallet(true);
    },
    disconnect: async () => {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(LOCAL_WALLET_STORAGE_KEY);
      }
      setSecretKey(null);
      setConnected(false);
      setHasStoredWallet(false);
    },
    createWallet: async (password?: string) => {
      const normalized = normalizePassword(password);
      const generated = Keypair.generate();
      const payload = await encryptSecret(generated.secretKey, normalized);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_WALLET_STORAGE_KEY, JSON.stringify(payload));
      }
      setSecretKey(generated.secretKey);
      setConnected(true);
      setHasStoredWallet(true);
    },
    importWallet: async (secretInput: string, password?: string) => {
      const normalized = normalizePassword(password);
      const parsed = parseImportedSecret(secretInput);
      if (!parsed) throw new Error("Invalid secret key format");
      const imported = Keypair.fromSecretKey(parsed);
      const payload = await encryptSecret(imported.secretKey, normalized);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_WALLET_STORAGE_KEY, JSON.stringify(payload));
      }
      setSecretKey(imported.secretKey);
      setConnected(true);
      setHasStoredWallet(true);
    },
    exportWallet: () => {
      if (!keypair) return null;
      return toStoredSecret(keypair.secretKey);
    },
    changePassword: async (currentPassword: string, nextPassword: string) => {
      const payload = loadStoredWalletPayload();
      if (!payload) throw new Error("No wallet found");
      const decoded = await decryptSecret(payload, normalizePassword(currentPassword));
      const nextPayload = await encryptSecret(decoded, normalizePassword(nextPassword));
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_WALLET_STORAGE_KEY, JSON.stringify(nextPayload));
      }
      setSecretKey(decoded);
      setConnected(true);
      setHasStoredWallet(true);
    },
    executeSwap: async ({ inputMint, outputMint, uiAmount, slippageBps = 100 }) => {
      if (!keypair || !connected) throw new Error("Wallet is not connected");
      const amount = uiToAtomicAmount(uiAmount, mintDecimals(inputMint));
      if (BigInt(amount) <= 0n) throw new Error("Trade amount must be greater than zero");

      const swapResponse = await fetch("/api/trade/jupiter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputMint,
          outputMint,
          amount,
          slippageBps,
          userPublicKey: keypair.publicKey.toBase58(),
        }),
      });
      if (!swapResponse.ok) {
        const detail = await swapResponse.text().catch(() => "");
        throw new Error(`Swap route failed (${swapResponse.status}) ${detail}`);
      }
      const swapPayload = await swapResponse.json();
      const quote = swapPayload?.quote;
      const base64Tx = String(swapPayload?.swapTransaction ?? "");
      if (!base64Tx) throw new Error("Jupiter did not return a swap transaction");

      const txBytes = fromBase64(base64Tx);
      const transaction = VersionedTransaction.deserialize(txBytes);
      transaction.sign([keypair]);
      const signedTx = transaction.serialize();
      const sendResponse = await fetch("/api/trade/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedTransaction: toBase64(signedTx),
          skipPreflight: false,
          maxRetries: 3,
        }),
      });
      if (!sendResponse.ok) {
        const detail = await sendResponse.text().catch(() => "");
        throw new Error(`Broadcast failed (${sendResponse.status}) ${detail}`);
      }
      const sendPayload = await sendResponse.json().catch(() => ({}));
      const txid = String(sendPayload?.txid ?? "");
      if (!txid) throw new Error("Broadcast route did not return a transaction signature");

      return {
        txid,
        inputMint,
        outputMint,
        inputAmount: uiAmount,
        outputAmount: Number(quote?.outAmount ?? 0) / (10 ** mintDecimals(outputMint)),
      };
    },
    passthroughWalletContextState,
  }), [connected, hasStoredWallet, keypair, passthroughWalletContextState]);

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
