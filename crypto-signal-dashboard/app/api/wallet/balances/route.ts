import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function getRpcEndpoint() {
  return process.env.SOLANA_RPC_URL ??
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    clusterApiUrl("mainnet-beta");
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  if (!address) {
    return new Response(JSON.stringify({ error: "Missing address" }), { status: 400 });
  }

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

    const tokens = [...holdingsByMint.entries()]
      .map(([mint, amount]) => ({ mint, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);

    let status = "Failed to sync wallet balances";
    if (solBalance !== null && tokenSourceAvailable) status = "Wallet synced";
    else if (solBalance !== null) status = "SOL balance synced (token accounts unavailable)";
    else if (tokenSourceAvailable) status = "Token balances synced (SOL balance unavailable)";

    return new Response(JSON.stringify({ solBalance, tokens, status }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Wallet sync failed" }), { status: 500 });
  }
}
