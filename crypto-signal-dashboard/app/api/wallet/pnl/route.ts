import { Connection, PublicKey, clusterApiUrl, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getRedisClient } from "@/lib/server/redis";

type PnlPoint = {
  t: number;
  v: number;
};

type LocalCacheEntry = {
  points: PnlPoint[];
  expiresAt: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __brembotPnlCache: Map<string, LocalCacheEntry> | undefined;
}

function getLocalCache() {
  if (!global.__brembotPnlCache) {
    global.__brembotPnlCache = new Map<string, LocalCacheEntry>();
  }
  return global.__brembotPnlCache;
}

function getRpcEndpoint() {
  return process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("mainnet-beta");
}

async function readCachedPnl(address: string): Promise<PnlPoint[] | null> {
  const local = getLocalCache().get(address);
  if (local && local.expiresAt > Date.now() && local.points.length > 0) {
    return local.points;
  }

  const redis = await getRedisClient().catch(() => null);
  if (!redis) return null;
  const key = `brembot:pnl:${address}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { points?: PnlPoint[] };
    if (!Array.isArray(parsed?.points)) return null;
    const points = parsed.points.filter((point) => Number.isFinite(point?.t) && Number.isFinite(point?.v));
    if (points.length > 0) {
      getLocalCache().set(address, {
        points,
        expiresAt: Date.now() + 90_000,
      });
    }
    return points;
  } catch {
    return null;
  }
}

async function writeCachedPnl(address: string, points: PnlPoint[]) {
  getLocalCache().set(address, {
    points,
    expiresAt: Date.now() + 90_000,
  });

  const redis = await getRedisClient().catch(() => null);
  if (!redis) return;
  const key = `brembot:pnl:${address}`;
  await redis.set(key, JSON.stringify({ points }), { EX: 90 });
}

async function fetchSolPriceUsd() {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { cache: "no-store" }
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const value = Number(payload?.solana?.usd ?? 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function fetchUsdPrices(mints: string[]) {
  const priceByMint = new Map<string, number>();
  if (mints.length === 0) return priceByMint;

  try {
    const response = await fetch(
      `https://price.jup.ag/v6/price?ids=${encodeURIComponent(mints.join(","))}`,
      { cache: "no-store" }
    );
    if (response.ok) {
      const payload = await response.json();
      const data = payload?.data ?? {};
      mints.forEach((mint) => {
        const price = Number(data?.[mint]?.price ?? 0);
        if (Number.isFinite(price) && price > 0) priceByMint.set(mint, price);
      });
    }
  } catch {
    // noop
  }

  return priceByMint;
}

function toAddressString(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input && "toBase58" in input) {
    const maybe = input as { toBase58?: () => string };
    if (typeof maybe.toBase58 === "function") return maybe.toBase58();
  }
  return String(input ?? "");
}

function tokenAmountToUiAmount(tokenAmount: unknown): number {
  if (!tokenAmount || typeof tokenAmount !== "object") return 0;
  const ta = tokenAmount as { uiAmount?: number; uiAmountString?: string };
  if (typeof ta.uiAmount === "number" && Number.isFinite(ta.uiAmount)) return ta.uiAmount;
  const parsed = Number(ta.uiAmountString ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractUsdDeltaFromTransaction(
  transaction: ParsedTransactionWithMeta,
  ownerAddress: string,
  priceByMint: Map<string, number>,
  solPriceUsd: number
) {
  const meta = transaction.meta;
  if (!meta) return 0;

  const accountKeys = transaction.transaction.message.accountKeys.map((key) => toAddressString(key));
  const ownerIndex = accountKeys.findIndex((key) => key === ownerAddress);

  let solDelta = 0;
  if (ownerIndex >= 0) {
    const preLamports = Number(meta.preBalances?.[ownerIndex] ?? 0);
    const postLamports = Number(meta.postBalances?.[ownerIndex] ?? 0);
    solDelta = (postLamports - preLamports) / 1_000_000_000;
  }

  const tokenDeltaByMint = new Map<string, number>();
  const preTokenBalances = meta.preTokenBalances ?? [];
  const postTokenBalances = meta.postTokenBalances ?? [];

  preTokenBalances.forEach((entry) => {
    if (!entry || entry.owner !== ownerAddress) return;
    const mint = String(entry.mint ?? "");
    if (!mint) return;
    const amount = tokenAmountToUiAmount(entry.uiTokenAmount);
    tokenDeltaByMint.set(mint, (tokenDeltaByMint.get(mint) ?? 0) - amount);
  });

  postTokenBalances.forEach((entry) => {
    if (!entry || entry.owner !== ownerAddress) return;
    const mint = String(entry.mint ?? "");
    if (!mint) return;
    const amount = tokenAmountToUiAmount(entry.uiTokenAmount);
    tokenDeltaByMint.set(mint, (tokenDeltaByMint.get(mint) ?? 0) + amount);
  });

  let usdDelta = solDelta * solPriceUsd;
  tokenDeltaByMint.forEach((delta, mint) => {
    const price = priceByMint.get(mint) ?? 0;
    if (!Number.isFinite(delta) || !Number.isFinite(price)) return;
    usdDelta += delta * price;
  });

  return Number.isFinite(usdDelta) ? usdDelta : 0;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = String(searchParams.get("address") ?? "").trim();
  if (!address) return new Response(JSON.stringify({ error: "Missing address" }), { status: 400 });
  const cached = await readCachedPnl(address).catch(() => null);
  if (cached && cached.length > 0) {
    return new Response(JSON.stringify({ points: cached, cached: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey(address);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid address" }), { status: 400 });
  }

  const connection = new Connection(getRpcEndpoint(), "confirmed");
  const now = Date.now();
  const ytdCutoff = new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
  const maxSignatures = 300;
  const signatures: string[] = [];
  let before: string | undefined;

  try {
    while (signatures.length < maxSignatures) {
      const page = await connection.getSignaturesForAddress(owner, { limit: 1000, before });
      if (page.length === 0) break;

      for (const item of page) {
        if (!item.signature) continue;
        if ((item.blockTime ?? 0) < ytdCutoff) {
          break;
        }
        signatures.push(item.signature);
        if (signatures.length >= maxSignatures) break;
      }

      const oldest = page[page.length - 1];
      if (!oldest?.signature || (oldest.blockTime ?? 0) < ytdCutoff || signatures.length >= maxSignatures) {
        break;
      }
      before = oldest.signature;
    }

    const transactions: ParsedTransactionWithMeta[] = [];
    for (let i = 0; i < signatures.length; i += 100) {
      const batch = signatures.slice(i, i + 100);
      const parsed = await connection.getParsedTransactions(batch, {
        maxSupportedTransactionVersion: 0,
      });
      parsed.forEach((tx) => {
        if (!tx || !tx.blockTime || tx.blockTime < ytdCutoff) return;
        if (!tx.meta) return;
        transactions.push(tx);
      });
    }

    const mints = new Set<string>();
    transactions.forEach((tx) => {
      (tx.meta?.preTokenBalances ?? []).forEach((entry) => {
        if (entry?.owner === address && entry.mint) mints.add(String(entry.mint));
      });
      (tx.meta?.postTokenBalances ?? []).forEach((entry) => {
        if (entry?.owner === address && entry.mint) mints.add(String(entry.mint));
      });
    });

    const [priceByMint, solPrice] = await Promise.all([
      fetchUsdPrices([...mints]),
      fetchSolPriceUsd(),
    ]);
    const solPriceUsd = solPrice ?? 0;

    const chronological = [...transactions].sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
    let cumulative = 0;
    const points: PnlPoint[] = [];

    chronological.forEach((tx) => {
      const usdDelta = extractUsdDeltaFromTransaction(tx, address, priceByMint, solPriceUsd);
      if (!Number.isFinite(usdDelta)) return;
      cumulative += usdDelta;
      points.push({ t: (tx.blockTime ?? Math.floor(now / 1000)) * 1000, v: cumulative });
    });

    if (points.length === 0) {
      points.push({ t: now, v: 0 });
    } else if (points[points.length - 1].t < now) {
      points.push({ t: now, v: cumulative });
    }
    await writeCachedPnl(address, points);

    return new Response(JSON.stringify({ points }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const fallback = await readCachedPnl(address).catch(() => null);
    if (fallback && fallback.length > 0) {
      return new Response(JSON.stringify({ points: fallback, cached: true, degraded: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const now = Date.now();
    return new Response(JSON.stringify({
      points: [{ t: now, v: 0 }],
      degraded: true,
      cached: false,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
