import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { fetchJupiterPerpsAccountSnapshot, fetchJupiterPerpsTradeHistory, type JupiterPerpsAccountSnapshot, type JupiterPerpsTrade } from "@/lib/jupiterPerps";
import { getRedisClient } from "@/lib/server/redis";
import { groupPnlEpisodes, type PnlEpisode, type RealizedPnlAccounting } from "@/lib/perps/pnlAccounting";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const KEY = "brembot:perps:pnl-accounting:v1";
const memory = new Map<string, { value: unknown; until: number }>();
const inflight = new Map<string, Promise<JupiterPerpsAccountSnapshot>>();
const episodeInflight = new Map<string, Promise<RealizedPnlAccounting>>();
let rpcAvailableAt = 0;
const round = (x: number) => Number(x.toFixed(9));

async function cached<T>(key: string): Promise<T | null> {
  const local = memory.get(key);
  if (local && local.until > Date.now()) return local.value as T;
  const redis = await getRedisClient().catch(() => null);
  const raw = await redis?.get(`${KEY}:${key}`).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
async function cache(key: string, value: unknown, seconds: number) {
  // Bound worker memory; durable Redis retains receipts across invocations.
  if (memory.size > 2000) memory.delete(memory.keys().next().value!);
  memory.set(key, {value, until: Date.now() + seconds * 1000});
  const redis = await getRedisClient().catch(() => null);
  await redis?.set(`${KEY}:${key}`, JSON.stringify(value), {EX: seconds}).catch(() => null);
}

export type PnlReceipt = {
  signature: string; at: number; accounts: string[]; usdcAtoms: string;
  paidNativeCostLamports: number; capitalDebitAtoms: string;
};

/** Extract actual wallet cash movements, not API-rounded trade.pnl/fee.
 * USDC swaps and protocol fees are already in the token delta. meta.fee already
 * includes priority fees. Keeper fees and refundable rent are NOT trader costs.
 */
export function readPnlReceipt(tx: ParsedTransactionWithMeta, wallet: string, signature: string): PnlReceipt {
  if (!tx.meta || !tx.blockTime) throw new Error("Transaction metadata is unavailable.");
  const accounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
  const balances = [...tx.meta.preTokenBalances ?? [], ...tx.meta.postTokenBalances ?? []];
  if (balances.some(b => !b.owner)) throw new Error("Token ownership is missing from historical metadata.");
  const sum = (rows: typeof tx.meta.preTokenBalances, mint: string) => (rows ?? [])
    .filter(b => b.owner === wallet && b.mint === mint)
    .reduce((a,b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  for (const mint of new Set(balances.filter(b => b.owner === wallet).map(b => b.mint))) {
    if (mint !== USDC && sum(tx.meta.postTokenBalances, mint) !== sum(tx.meta.preTokenBalances, mint)) {
      throw new Error("Non-USDC settlement needs a token-specific cashflow reconciliation.");
    }
  }
  const delta = sum(tx.meta.postTokenBalances, USDC) - sum(tx.meta.preTokenBalances, USDC);
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(x => x.instructions)];
  // Count native tips/service transfers, but not rent creation or transient
  // WSOL funding that is returned through a token-account close.
  const created = new Set(instructions.flatMap(i => "parsed" in i && /createAccount/.test(i.parsed?.type ?? "")
    ? [i.parsed.info.newAccount] : []));
  const ownedTokenAccounts = new Set(balances.filter(b => b.owner === wallet).map(b => accounts[b.accountIndex]));
  const transientAccounts = new Set(instructions.flatMap(i => "parsed" in i && i.parsed?.type === "closeAccount" && i.parsed.info.destination === wallet
    ? [i.parsed.info.account] : []));
  const tips = tx.meta.err ? 0 : instructions.reduce((total, i) => {
    if (!("parsed" in i) || i.program !== "system" || i.parsed?.type !== "transfer" || i.parsed.info.source !== wallet) return total;
    const target = i.parsed.info.destination;
    return target === wallet || created.has(target) || ownedTokenAccounts.has(target) || transientAccounts.has(target)
      ? total : total + Number(i.parsed.info.lamports ?? 0);
  }, 0);
  return {
    signature, at: tx.blockTime * 1000, accounts,
    usdcAtoms: delta.toString(), capitalDebitAtoms: (delta < 0n ? -delta : 0n).toString(),
    paidNativeCostLamports: (accounts[0] === wallet ? tx.meta.fee : 0) + tips,
  };
}

export function settlePnlReceipts(episodeId: string, receipts: PnlReceipt[], solUsd: number, asOf: number): RealizedPnlAccounting {
  if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error("Historical SOL/USD valuation is unavailable.");
  const unique = [...new Map(receipts.map(r => [r.signature, r])).values()];
  const cash = Number(unique.reduce((sum,r) => sum + BigInt(r.usdcAtoms), 0n)) / 1e6;
  const capital = Number(unique.reduce((sum,r) => sum + BigInt(r.capitalDebitAtoms), 0n)) / 1e6;
  if (capital <= 0) throw new Error("Opening wallet debit has not been reconciled.");
  const sol = unique.reduce((sum,r) => sum + r.paidNativeCostLamports, 0) / 1e9;
  const feeUsd = sol * solUsd;
  const net = cash - feeUsd;
  return {version:1, episodeId, status:"reconciled", netPnlUsd:round(net), netRoePercent:round(net/capital*100), capitalUsd:capital,
    cashflowUsdc:cash, networkFeeSol:sol, networkFeeUsd:round(feeUsd), feeConversionSolUsd:solUsd,
    feeConversionSource:"Historical SOL/USD at settlement; exact native fee units retained", signatures:unique.map(r=>r.signature), asOf};
}

async function historicalSolPrice(episode: PnlEpisode) {
  const exit = episode.trades.at(-1)!;
  if (exit.marketSymbol.toUpperCase().includes("SOL") && exit.price != null && exit.price > 0) return exit.price;
  const minute = Math.floor((episode.closedAt ?? Date.now()) / 60000) * 60000;
  const key = `sol-price:${minute}`;
  const stored = await cached<number>(key);
  if (stored) return stored;
  const query = new URLSearchParams({granularity:"60",start:new Date(minute).toISOString(),end:new Date(minute+60000).toISOString()});
  const response = await fetch(`https://api.exchange.coinbase.com/products/SOL-USD/candles?${query}`, {signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error("Historical SOL/USD is unavailable.");
  const rows = await response.json() as number[][];
  const price = rows.find(row => row[0]! * 1000 === minute)?.[4];
  if (!price || !Number.isFinite(price)) throw new Error("Historical SOL/USD candle is missing.");
  await cache(key,price,86400*30); return price;
}

async function auditEpisode(wallet: string, episode: PnlEpisode, episodes: PnlEpisode[], deadline: number) {
  const key = `${wallet}:${episode.id}`;
  if (episodeInflight.has(key)) return episodeInflight.get(key)!;
  const task = auditEpisodeReceipts(wallet,episode,episodes,deadline);
  episodeInflight.set(key,task);
  try { return await task; } finally { episodeInflight.delete(key); }
}

async function auditEpisodeReceipts(wallet: string, episode: PnlEpisode, episodes: PnlEpisode[], deadline: number): Promise<RealizedPnlAccounting> {
  const recordKey = `episode:${wallet}:${episode.id}`;
  const previous = await cached<RealizedPnlAccounting>(recordKey);
  if (previous?.status === "reconciled" || (previous && previous.asOf > Date.now()-15000)) return previous;
  const pending: RealizedPnlAccounting = {version:1,episodeId:episode.id,status:episode.closedAt?"reconciling":"open",netPnlUsd:null,netRoePercent:null,capitalUsd:null,asOf:Date.now()};
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, {commitment:"finalized",disableRetryOnRateLimit:true,
    fetch: async (url, init) => {
      // Public archival RPC limits are much lower than quote API limits.
      // Pace all accounting calls in this worker; receipts resume next refresh.
      const slot = Math.max(Date.now(),rpcAvailableAt);
      if (slot > deadline) throw new Error("Fee reconciliation continues on the next refresh.");
      rpcAvailableAt = slot + 1200;
      if (slot > Date.now()) await new Promise(resolve=>setTimeout(resolve,slot-Date.now()));
      return fetch(url, {...init, signal:AbortSignal.timeout(5000)});
    }});
  try {
    const end = Math.min(episode.closedAt ? episode.closedAt + 60000 : Date.now(), (episode.nextOpenedAt ?? Infinity)-1);
    if (episode.closedAt && Date.now() < end+30000) throw new Error("Waiting for finalized closing and cleanup transactions.");
    let before: string | undefined;
    const signatures: {signature:string;blockTime:number|null}[] = [];
    let covered = false;
    // Persist pagination as well as receipts: large episodes resume, not rescan.
    const scanKey = `scan:${wallet}:${episode.id}:${episode.closedAt ?? 'open'}`;
    const scan = episode.closedAt ? await cached<{before?:string;covered:boolean;signatures:typeof signatures}>(scanKey) : null;
    if (scan) {before=scan.before; covered=scan.covered; signatures.push(...scan.signatures);}
    for (let page=0; !covered && page<10; page++) {
      if (Date.now()>deadline) throw new Error("Transaction scan continues on the next refresh.");
      const rows = await connection.getSignaturesForAddress(new PublicKey(episode.position), {limit:100,...(before?{before}:{})}, "finalized");
      for (const row of rows) if (row.blockTime != null && row.blockTime*1000 >= episode.openedAt && row.blockTime*1000 <= end) signatures.push({signature:row.signature,blockTime:row.blockTime});
      covered = rows.length===0 || (rows.at(-1)?.blockTime != null && rows.at(-1)!.blockTime!*1000 < episode.openedAt);
      before=rows.at(-1)?.signature;
      if (episode.closedAt) await cache(scanKey,{before,covered,signatures},86400);
    }
    if (!covered) throw new Error("Historical transaction coverage is incomplete.");
    const unique = [...new Map(signatures.map(s=>[s.signature,s])).values()];
    const tradeSignatures = episode.trades.map(t=>t.txHash).filter((s):s is string=>Boolean(s));
    if (tradeSignatures.length !== episode.trades.length || tradeSignatures.some(s=>!unique.some(x=>x.signature===s))) throw new Error("Not all entry/exit transactions are finalized yet.");
    const receipts: PnlReceipt[] = [];
    for (const item of unique) {
      const key=`receipt:${wallet}:${item.signature}`;
      let receipt=await cached<PnlReceipt>(key);
      if (!receipt) {
        if (Date.now()>deadline) throw new Error("Fee reconciliation continues on the next refresh.");
        const tx=await connection.getParsedTransaction(item.signature,{maxSupportedTransactionVersion:0,commitment:"finalized"});
        if (!tx) throw new Error("A required transaction is unavailable from the RPC provider.");
        receipt=readPnlReceipt(tx,wallet,item.signature);
        await cache(key,receipt,86400*30);
      }
      if (episodes.some(other=>other.position!==episode.position && receipt!.accounts.includes(other.position)
        && other.openedAt<=receipt!.at && (other.closedAt??Infinity)>=receipt!.at)) throw new Error("A multi-position transaction needs explicit cost allocation.");
      receipts.push(receipt);
    }
    const result=settlePnlReceipts(episode.id,receipts,await historicalSolPrice(episode),Date.now());
    if (!episode.closedAt) result.status="open";
    await cache(recordKey,result,episode.closedAt?86400*365:15);
    return result;
  } catch (error) {
    pending.reason=error instanceof Error?error.message:"Accounting is unavailable.";
    if (/429|Too many requests/i.test(pending.reason)) pending.reason="Transaction provider is rate-limited; reconciliation will retry.";
    await cache(recordKey,pending,15); return pending;
  }
}

/** Presentation-only enrichment. Raw exchange pnl/fees remain untouched so
 * this display correction does not silently alter entry/exit trading policy. */
export async function enrichPerpsPnlAccounting(wallet: string, snapshot: JupiterPerpsAccountSnapshot, history: JupiterPerpsTrade[] = snapshot.recentTrades) {
  const episodes=groupPnlEpisodes(history);
  const rowKey=(t:JupiterPerpsTrade)=>`${t.txHash??t.id}:${t.positionPubkey}:${t.action}:${t.createdAt}`;
  const rows=new Map(history.map(t=>[rowKey(t), {...t,pnlAccounting:{version:1,episodeId:t.id,status:"reconciling",netPnlUsd:null,netRoePercent:null,capitalUsd:null,asOf:Date.now()} as RealizedPnlAccounting}]));
  const positions=snapshot.positions.map(p=>({...p}));
  const deadline=Date.now()+8000;
  for (const episode of episodes) {
    const position=positions.find(p=>p.accountRef===episode.position && !episode.closedAt);
    // A remaining live position / pre-close trigger makes a claimed full close
    // provisional, even if the rounded trade-history sizes look fully reduced.
    const unresolvedClose=episode.closedAt && !episode.nextOpenedAt && (positions.some(p=>p.accountRef===episode.position)
      || snapshot.pendingTriggers.some(t=>t.positionPubkey===episode.position && (t.lastUpdated??0)<=episode.closedAt!));
    const stored=await cached<RealizedPnlAccounting>(`episode:${wallet}:${episode.id}`);
    const accounting=unresolvedClose ? {version:1 as const,episodeId:episode.id,status:"reconciling" as const,netPnlUsd:null,netRoePercent:null,capitalUsd:null,asOf:Date.now(),reason:"Position or closing orders are still active."}
      : stored?.status==="reconciled" ? stored
      : Date.now()<deadline ? await auditEpisode(wallet,episode,episodes,deadline)
      : {version:1 as const,episodeId:episode.id,status:episode.closedAt?"reconciling" as const:"open" as const,netPnlUsd:null,netRoePercent:null,capitalUsd:null,asOf:Date.now()};
    for (const trade of episode.trades) {
      const row=rows.get(rowKey(trade))!;
      const terminal=episode.closedAt && trade===episode.trades.at(-1);
      row.pnlAccounting=terminal?accounting:{...accounting,status:episode.closedAt?"included":"open",netPnlUsd:null,netRoePercent:null};
    }
    if (position && accounting.capitalUsd && accounting.networkFeeUsd!=null) {
      const providerFunding=episode.trades.reduce((sum,t)=>sum+(t.collateralUsdDelta??0),0);
      position.pnlCostBasis={capitalUsd:accounting.capitalUsd,
        fundingAdjustmentUsd: Math.max(0,providerFunding-(accounting.cashflowUsdc??providerFunding)),
        paidNetworkFeesUsd:accounting.networkFeeUsd,asOf:accounting.asOf};
    }
  }
  return {...snapshot,positions,recentTrades:[...rows.values()]};
}

/** Shared short-lived snapshot: chart/widgets/notifications consume the same
 * source and cost basis; OS widget refresh timing can still differ. */
export async function loadAccountedPerpsSnapshot(wallet: string): Promise<JupiterPerpsAccountSnapshot> {
  const key=`snapshot:${wallet}`;
  const prior=await cached<JupiterPerpsAccountSnapshot>(key);
  if (prior) return prior;
  if (inflight.has(wallet)) return inflight.get(wallet)!;
  const task=(async()=>{
    const raw=await fetchJupiterPerpsAccountSnapshot(wallet);
    let history=await cached<JupiterPerpsTrade[]>(`history:${wallet}`);
    if (!history) {
      const result=await fetchJupiterPerpsTradeHistory(wallet).catch(()=>null);
      history=result?.trades??raw.recentTrades;
      await cache(`history:${wallet}`,history,60);
    }
    const merged=[...new Map([...history,...raw.recentTrades].map(t=>[`${t.txHash??t.id}:${t.positionPubkey}:${t.action}:${t.createdAt}`,t])).values()];
    const result=await enrichPerpsPnlAccounting(wallet,raw,merged);
    await cache(key,result,5);return result;
  })();
  inflight.set(wallet,task);
  try{return await task;}finally{inflight.delete(wallet);}
}
