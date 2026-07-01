import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

import { getRedisClient } from "@/lib/server/redis";

const AUTH_TTL_SECONDS = 60 * 60 * 12;
const CHALLENGE_TTL_SECONDS = 60 * 5;
const CHALLENGE_VERSION = "brembot-auth-v1";

type StoredChallenge = {
  address: string;
  challengeId: string;
  nonce: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
};

function toToken() {
  return `${crypto.randomUUID()}-${Math.random().toString(36).slice(2)}`;
}

function isValidAddress(address: string) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function buildChallenge(address: string) {
  const challengeId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const issuedAtDate = new Date();
  const expiresAtDate = new Date(issuedAtDate.getTime() + CHALLENGE_TTL_SECONDS * 1000);
  const issuedAt = issuedAtDate.toISOString();
  const expiresAt = expiresAtDate.toISOString();
  const message = [
    "BremLogic wants you to sign in with your Solana wallet.",
    `Version: ${CHALLENGE_VERSION}`,
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join("\n");

  return {
    challengeId,
    nonce,
    issuedAt,
    expiresAt,
    message,
  };
}

function challengeKey(challengeId: string) {
  return `brembot:trades:challenge:${challengeId}`;
}

function sessionKey(token: string) {
  return `brembot:trades:session:${token}`;
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const address = String(payload?.address ?? "").trim();
  if (!address) {
    return new Response(JSON.stringify({ error: "Missing address" }), { status: 400 });
  }
  if (!isValidAddress(address)) {
    return new Response(JSON.stringify({ error: "Invalid address" }), { status: 400 });
  }

  const redis = await getRedisClient().catch(() => null);
  if (!redis) {
    return new Response(JSON.stringify({ error: "Remote storage unavailable" }), { status: 503 });
  }

  const challenge = buildChallenge(address);
  const storedChallenge: StoredChallenge = {
    address,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    message: challenge.message,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };

  await redis.set(challengeKey(challenge.challengeId), JSON.stringify(storedChallenge), {
    EX: CHALLENGE_TTL_SECONDS,
  });

  return new Response(
    JSON.stringify({
      address,
      challengeId: challenge.challengeId,
      message: challenge.message,
      expiresInSeconds: CHALLENGE_TTL_SECONDS,
      expiresAt: challenge.expiresAt,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

export async function PUT(request: Request) {
  const payload = await request.json().catch(() => null);
  const address = String(payload?.address ?? "").trim();
  const challengeId = String(payload?.challengeId ?? "").trim();
  const signatureBase58 = String(payload?.signature ?? "").trim();

  if (!address || !challengeId || !signatureBase58) {
    return new Response(JSON.stringify({ error: "Missing address, challengeId, or signature" }), { status: 400 });
  }
  if (!isValidAddress(address)) {
    return new Response(JSON.stringify({ error: "Invalid address" }), { status: 400 });
  }

  const redis = await getRedisClient().catch(() => null);
  if (!redis) {
    return new Response(JSON.stringify({ error: "Remote storage unavailable" }), { status: 503 });
  }

  const rawChallenge = await redis.get(challengeKey(challengeId));
  if (!rawChallenge) {
    return new Response(JSON.stringify({ error: "Challenge expired or missing" }), { status: 401 });
  }

  let storedChallenge: StoredChallenge | null = null;
  try {
    storedChallenge = JSON.parse(String(rawChallenge)) as StoredChallenge;
  } catch {
    storedChallenge = null;
  }

  if (!storedChallenge || storedChallenge.address !== address || storedChallenge.challengeId !== challengeId) {
    return new Response(JSON.stringify({ error: "Challenge mismatch" }), { status: 401 });
  }

  try {
    const publicKeyBytes = new PublicKey(address).toBytes();
    const signature = bs58.decode(signatureBase58);
    const message = new TextEncoder().encode(storedChallenge.message);
    const isValid = nacl.sign.detached.verify(message, signature, publicKeyBytes);
    if (!isValid) {
      return new Response(JSON.stringify({ error: "Invalid wallet signature" }), { status: 401 });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Unable to verify wallet signature" }), { status: 401 });
  }

  await redis.del(challengeKey(challengeId));

  const token = toToken();
  await redis.set(sessionKey(token), address, { EX: AUTH_TTL_SECONDS });

  return new Response(
    JSON.stringify({
      token,
      address,
      expiresInSeconds: AUTH_TTL_SECONDS,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}
