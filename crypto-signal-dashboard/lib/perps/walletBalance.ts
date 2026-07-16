import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export function getServerSolanaConnection() {
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim()
    || process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim()
    || clusterApiUrl("mainnet-beta");
  return new Connection(rpcUrl, "confirmed");
}
export async function getWalletUsdcBalance(walletAddress: string | null) {
  if (!walletAddress) return null;
  const accounts = await getServerSolanaConnection().getParsedTokenAccountsByOwner(
    new PublicKey(walletAddress),
    { mint: USDC_MINT }
  );
  return accounts.value.reduce((sum, entry) => {
    const amount = entry.account.data.parsed?.info?.tokenAmount?.uiAmount;
    return sum + (typeof amount === "number" && Number.isFinite(amount) ? amount : 0);
  }, 0);
}
