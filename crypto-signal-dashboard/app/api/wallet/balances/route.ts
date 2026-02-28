import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SOL_ICON = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png";

type TokenDetails = {
  mint: string;
  amount: number;
  symbol: string;
  name: string;
  logoURI: string | null;
  usdPrice: number | null;
  usdValue: number | null;
};

type TokenProfile = {
  symbol: string;
  name: string;
  logoURI: string | null;
};

function getRpcEndpoint() {
  return process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("mainnet-beta");
}

function shortAddress(address: string) {
  return `${address.slice(0, 4)}..${address.slice(-4)}`;
}

async function fetchTokenProfileFromJupiter(mint: string): Promise<TokenProfile | null> {
  try {
    const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mint}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return {
      symbol: String(payload?.symbol ?? "").trim(),
      name: String(payload?.name ?? "").trim(),
      logoURI: typeof payload?.logoURI === "string" ? payload.logoURI : null,
    };
  } catch {
    return null;
  }
}

async function fetchTokenProfileFromDexScreener(mint: string): Promise<TokenProfile | null> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const pair = Array.isArray(payload?.pairs) ? payload.pairs[0] : null;
    const base = pair?.baseToken;
    const quote = pair?.quoteToken;
    const candidate = base?.address === mint ? base : quote?.address === mint ? quote : base;
    if (!candidate) return null;

    return {
      symbol: String(candidate.symbol ?? "").trim(),
      name: String(candidate.name ?? "").trim(),
      logoURI: null,
    };
  } catch {
    return null;
  }
}

async function fetchTokenProfile(mint: string): Promise<TokenProfile | null> {
  const [jupiter, dex] = await Promise.all([
    fetchTokenProfileFromJupiter(mint),
    fetchTokenProfileFromDexScreener(mint),
  ]);

  const symbol = jupiter?.symbol || dex?.symbol || shortAddress(mint);
  const name = jupiter?.name || dex?.name || shortAddress(mint);
  const logoURI = jupiter?.logoURI ?? null;
  return { symbol, name, logoURI };
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

  const unresolved = mints.filter((mint) => !priceByMint.has(mint));
  await Promise.all(
    unresolved.map(async (mint) => {
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = await response.json();
        const pair = Array.isArray(payload?.pairs) ? payload.pairs[0] : null;
        const priceUsd = Number(pair?.priceUsd ?? 0);
        if (Number.isFinite(priceUsd) && priceUsd > 0) priceByMint.set(mint, priceUsd);
      } catch {
        // noop
      }
    })
  );

  return priceByMint;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  if (!address) return new Response(JSON.stringify({ error: "Missing address" }), { status: 400 });

  let owner: PublicKey;
  try {
    owner = new PublicKey(address);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid address" }), { status: 400 });
  }

  const connection = new Connection(getRpcEndpoint(), "confirmed");

  try {
    const [balanceResult, splTokenAccountsResult, token2022AccountsResult] = await Promise.allSettled([
      connection.getBalance(owner, "confirmed"),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    let solBalance: number | null = null;
    if (balanceResult.status === "fulfilled") {
      solBalance = balanceResult.value / 1_000_000_000;
    } else {
      try {
        const accountInfo = await connection.getAccountInfo(owner, "finalized");
        solBalance = accountInfo ? accountInfo.lamports / 1_000_000_000 : null;
      } catch {
        solBalance = null;
      }
    }

    const holdingsByMint = new Map<string, number>();
    let tokenSourceAvailable = false;

    [splTokenAccountsResult, token2022AccountsResult].forEach((result) => {
      if (result.status !== "fulfilled") return;
      tokenSourceAvailable = true;
      result.value.value.forEach((accountInfo) => {
        const parsedInfo = accountInfo.account.data.parsed?.info;
        const mint = String(parsedInfo?.mint ?? "");
        const uiAmount = Number(parsedInfo?.tokenAmount?.uiAmount ?? 0);
        const uiAmountString = Number(parsedInfo?.tokenAmount?.uiAmountString ?? 0);
        const amount = Number.isFinite(uiAmount) && uiAmount > 0 ? uiAmount : uiAmountString;
        if (!mint || !Number.isFinite(amount) || amount <= 0) return;
        holdingsByMint.set(mint, (holdingsByMint.get(mint) ?? 0) + amount);
      });
    });

    const topEntries = [...holdingsByMint.entries()]
      .map(([mint, amount]) => ({ mint, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 12);

    const mintList = topEntries.map((entry) => entry.mint);
    const [prices, profiles, solPriceUsd] = await Promise.all([
      fetchUsdPrices(mintList),
      Promise.all(mintList.map((mint) => fetchTokenProfile(mint))),
      fetchSolPriceUsd(),
    ]);

    const tokens: TokenDetails[] = topEntries.slice(0, 8).map((entry, idx) => {
      const profile = profiles[idx];
      const usdPrice = prices.get(entry.mint) ?? null;
      const usdValue = usdPrice !== null ? entry.amount * usdPrice : null;
      return {
        mint: entry.mint,
        amount: entry.amount,
        symbol: profile?.symbol || shortAddress(entry.mint),
        name: profile?.name || shortAddress(entry.mint),
        logoURI: profile?.logoURI ?? null,
        usdPrice,
        usdValue,
      };
    });

    const solValueUsd = solBalance !== null && solPriceUsd !== null ? solBalance * solPriceUsd : null;
    const tokenTotalUsd = tokens.reduce((sum, token) => sum + (token.usdValue ?? 0), 0);
    const totalBalanceUsd = (solValueUsd ?? 0) + tokenTotalUsd;

    let status = "Failed to sync wallet balances";
    if (solBalance !== null && tokenSourceAvailable) status = "Wallet synced";
    else if (solBalance !== null) status = "SOL balance synced (token accounts unavailable)";
    else if (tokenSourceAvailable) status = "Token balances synced (SOL balance unavailable)";

    return new Response(
      JSON.stringify({
        solBalance,
        solPriceUsd,
        solValueUsd,
        totalBalanceUsd,
        tokens,
        status,
        solMeta: { symbol: "SOL", name: "Solana", logoURI: SOL_ICON },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch {
    return new Response(JSON.stringify({ error: "Wallet sync failed" }), { status: 500 });
  }
}
