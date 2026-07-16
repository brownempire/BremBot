import bs58 from "bs58";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

import { PerpsExecutionError } from "@/lib/perps/errors";

function parsePrivateKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new PerpsExecutionError("MISSING_TRADING_WALLET_KEY", "PERPS_TRADING_WALLET_PRIVATE_KEY is not configured.", 500);
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new PerpsExecutionError("INVALID_TRADING_WALLET_KEY", "PERPS_TRADING_WALLET_PRIVATE_KEY JSON array is invalid.", 500);
    }
    return Uint8Array.from(parsed);
  }

  return bs58.decode(trimmed);
}

export function getPerpsTradingKeypair() {
  const privateKey = process.env.PERPS_AGENT_WALLET_PRIVATE_KEY || process.env.PERPS_TRADING_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new PerpsExecutionError(
      "MISSING_TRADING_WALLET_KEY",
      "PERPS_AGENT_WALLET_PRIVATE_KEY is not configured.",
      500
    );
  }

  return Keypair.fromSecretKey(parsePrivateKey(privateKey));
}

export function signSerializedPerpsTransaction(serializedTxBase64: string) {
  const keypair = getPerpsTradingKeypair();
  const raw = Buffer.from(serializedTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
  const expectedFeePayer =
    process.env.PERPS_AGENT_WALLET_PUBLIC_KEY?.trim()
    || process.env.PERPS_TRADING_WALLET_PUBLIC_KEY?.trim()
    || keypair.publicKey.toBase58();

  if (feePayer && feePayer !== expectedFeePayer) {
    throw new PerpsExecutionError(
      "FEE_PAYER_MISMATCH",
      `Refusing to sign a Jupiter Perps transaction for fee payer ${feePayer}. Expected ${expectedFeePayer}.`,
      400
    );
  }

  const requiredSigners = tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((key) => key.toBase58());
  if (!requiredSigners.includes(keypair.publicKey.toBase58())) {
    throw new PerpsExecutionError(
      "SIGNER_NOT_REQUIRED",
      "Refusing to sign a Jupiter Perps transaction that does not require the configured agent wallet.",
      400
    );
  }

  tx.sign([keypair]);
  return {
    signedSerializedTxBase64: Buffer.from(tx.serialize()).toString("base64"),
    signerPublicKey: keypair.publicKey.toBase58(),
  };
}
