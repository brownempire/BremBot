import { clusterApiUrl, Connection } from "@solana/web3.js";

type SendTradeRequest = {
  signedTransaction?: string;
  skipPreflight?: boolean;
  maxRetries?: number;
};

function resolveRpcEndpoint() {
  const serverRpc = process.env.SOLANA_RPC_URL?.trim();
  if (serverRpc && /^https?:\/\//.test(serverRpc)) return serverRpc;
  const publicRpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  if (publicRpc && /^https?:\/\//.test(publicRpc)) return publicRpc;
  return clusterApiUrl("mainnet-beta");
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as SendTradeRequest;
  const signedTransaction = String(body.signedTransaction ?? "");
  if (!signedTransaction) {
    return new Response(JSON.stringify({ error: "Missing signedTransaction" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const connection = new Connection(resolveRpcEndpoint(), "confirmed");
    const rawTx = Buffer.from(signedTransaction, "base64");
    const txid = await connection.sendRawTransaction(rawTx, {
      skipPreflight: Boolean(body.skipPreflight),
      maxRetries: Number.isFinite(body.maxRetries) ? Number(body.maxRetries) : 3,
    });
    await connection.confirmTransaction(txid, "confirmed");

    return new Response(JSON.stringify({ ok: true, txid }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Transaction broadcast failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
