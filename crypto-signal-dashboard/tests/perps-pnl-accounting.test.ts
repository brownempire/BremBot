import assert from "node:assert/strict";
import test from "node:test";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import type { JupiterPerpsPosition, JupiterPerpsTrade } from "../lib/jupiterPerps";
import { estimateNetExitPnl, groupPnlEpisodes, realizedTradePnl } from "../lib/perps/pnlAccounting";
import { readPnlReceipt, settlePnlReceipts, type PnlReceipt } from "../lib/perps/pnlAccountingServer";
import { buildPerpsPnlSummary } from "../lib/perps/pnl";
import { summarizePositionOverlayEstimatedNetPnl, summarizePositionOverlayEstimatedNetPnlPercent } from "../lib/chart/positionOverlay";
import { buildWidgetServerSnapshot } from "../lib/widget/serverSnapshot";
import { buildTradeExitNotification } from "../lib/perps/tradeNotifications";
import { runPerpsTradeNotificationWatch } from "../lib/perps/tradeNotifications";
import type { StoredPerpsWatchState } from "../lib/perpsWatchStore";

const position = {id:"p",accountRef:"p",source:"live-api",marketSymbol:"SOL",marketName:"SOL",side:"long",entryPrice:99.65,markPrice:99.93,
  positionValue:304.46,positionSize:3.0553,collateralValue:11.77,unrealizedPnl:0.65,
  takeProfit:100.64,stopLoss:99.93,liquidationPrice:95,
  pnlCostBasis:{capitalUsd:12,fundingAdjustmentUsd:0.012,paidNetworkFeesUsd:0.00567,asOf:1}} as JupiterPerpsPosition;
const row = (id:string,action:string,size:number,at:number) => ({id,source:"live-api",positionPubkey:"p",marketSymbol:"SOL",side:"long",action,orderType:"Market",
  price:99.93,sizeUsd:size,collateralUsdDelta:0,feeUsd:0.23,pnl:0.64,pnlPercentage:7.35,txHash:id,createdAt:at,lastUpdated:at}) as JupiterPerpsTrade;
const receipts: PnlReceipt[] = [
  {signature:"entry",at:1,accounts:["p"],usdcAtoms:"-12000000",capitalDebitAtoms:"12000000",paidNativeCostLamports:16016},
  {signature:"tp-sl",at:2,accounts:["p"],usdcAtoms:"0",capitalDebitAtoms:"0",paidNativeCostLamports:20492},
  {signature:"raise-sl",at:3,accounts:["p"],usdcAtoms:"0",capitalDebitAtoms:"0",paidNativeCostLamports:20247},
  {signature:"exit",at:4,accounts:["p"],usdcAtoms:"12398630",capitalDebitAtoms:"0",paidNativeCostLamports:0},
];

test("reference trade reconciles exact USDC and trader-paid SOL fees to $0.392958473, not $0.64/$0.43",()=>{
  const accounting=settlePnlReceipts("episode",[...receipts,receipts[0]!],99.93,100);
  assert.equal(accounting.cashflowUsdc,0.39863);
  assert.equal(accounting.networkFeeSol,0.000056755);
  assert.equal(accounting.netPnlUsd,0.392958473);
  assert.equal(accounting.netRoePercent,3.27465394);
  assert.equal(accounting.capitalUsd,12);
  assert.throws(()=>settlePnlReceipts("episode",receipts,NaN,100),/valuation/);
});

test("same estimated dollars and ROE reach chart, widgets and wallet without another opening-fee debit",()=>{
  const estimate=estimateNetExitPnl(position)!;
  const widget=buildWidgetServerSnapshot({agentPositions:[position],mainAvailableUsdc:0,agentAvailableUsdc:0,session:null});
  assert.equal(widget.openPerpPnlUsd,estimate.estimatedNetPnlUsd);
  assert.equal(widget.openPerpPnlPercent,estimate.estimatedNetRoePercent);
  assert.equal(summarizePositionOverlayEstimatedNetPnl([position]),widget.openPerpPnlUsd);
  assert.equal(summarizePositionOverlayEstimatedNetPnlPercent([position]),widget.openPerpPnlPercent);
  const opening={...row("entry","Increase",304.46,1),pnlAccounting:{version:1 as const,episodeId:"episode",status:"open" as const,netPnlUsd:null,netRoePercent:null,capitalUsd:12,asOf:1}};
  const summary=buildPerpsPnlSummary([opening],[position]);
  assert.equal(summary.realizedPnlUsd,0);
  assert.equal(summary.unrealizedPnlUsd,widget.openPerpPnlUsd);
  assert.equal(summary.totalPnlUsd,widget.openPerpPnlUsd);
  assert.equal(estimateNetExitPnl({...position,source:"rpc-direct"}),null,"gross fallback has no accrued borrowing data");
});

test("notification, recent-trade accessor and wallet share settled totals and never reuse gross percent",()=>{
  const accounting=settlePnlReceipts("episode",receipts,99.93,100);
  const close={...row("exit","Close",304.46,4),pnlAccounting:accounting};
  const open={...row("entry","Increase",304.46,1),pnlAccounting:{...accounting,status:"included" as const,netPnlUsd:null,netRoePercent:null}};
  const summary=buildPerpsPnlSummary([open,close,close],[]);
  assert.equal(summary.realizedPnlUsd,0.392958);
  assert.equal(summary.tradeCount,1);
  assert.equal(summary.points[0]?.trade?.pnlPercentage,accounting.netRoePercent);
  assert.equal(realizedTradePnl(close),accounting);
  const notice=buildTradeExitNotification({walletAddress:"wallet",position,previousTriggers:[],recentTrades:[close]});
  assert.match(notice.body,/Realized net \+\$0\.39 \(3\.27%\)/);
  assert.doesNotMatch(notice.body,/\$0\.64|7\.35%|Est\. net/);
  const missing=buildTradeExitNotification({walletAddress:"wallet",position,previousTriggers:[],recentTrades:[row("pending","Close",304.46,4)]});
  assert.match(missing.body,/reconciling/);
  assert.equal(buildPerpsPnlSummary([row("pending","Close",304.46,4)],[]).accountingComplete,false);
});

test("episodes retain scale-ins and partial exits, and split reused position addresses",()=>{
  const trades=[row("entry","Increase",100,1000),row("add","Increase",50,2000),row("partial","Decrease",60,3000),
    row("close","Decrease",90,4000),row("again","Increase",100,5000)];
  const episodes=groupPnlEpisodes([...trades,trades[0]!]);
  assert.equal(episodes.length,2);
  assert.equal(episodes[0]?.closedAt,null);
  assert.equal(episodes[1]?.closedAt,4000);
  assert.equal(episodes[1]?.trades.length,4);
  assert.equal(episodes[1]?.nextOpenedAt,5000);
  assert.equal(groupPnlEpisodes([row("orphan","Decrease",10,1000)]).length,0);
});

test("receipt accounting excludes keeper fees and refunded rent, includes trader fees on failed transactions",()=>{
  const wallet="wallet";
  const pubkey=(key:string)=>({toBase58:()=>key});
  const tx={blockTime:1,transaction:{message:{accountKeys:[{pubkey:pubkey("keeper")},{pubkey:pubkey(wallet)}],instructions:[]}},meta:{err:null,fee:22552,
    preBalances:[100000,100000],postBalances:[77448,5201680],preTokenBalances:[],postTokenBalances:[],innerInstructions:[]}} as unknown as ParsedTransactionWithMeta;
  assert.equal(readPnlReceipt(tx,wallet,"keeper-close").paidNativeCostLamports,0);
  const failed={...tx,transaction:{...tx.transaction,message:{...tx.transaction.message,accountKeys:[{pubkey:pubkey(wallet)}] }},meta:{...tx.meta!,err:{InstructionError:[0,"error"]},fee:16016}} as unknown as ParsedTransactionWithMeta;
  assert.equal(readPnlReceipt(failed,wallet,"failed").paidNativeCostLamports,16016);
});

test("holding-cost updates and already-paid transaction fees change every open-PnL display equally",()=>{
  const before = estimateNetExitPnl(position)!;
  const after = estimateNetExitPnl({...position,unrealizedPnl:position.unrealizedPnl!-0.2,
    pnlCostBasis:{...position.pnlCostBasis!,paidNetworkFeesUsd:position.pnlCostBasis!.paidNetworkFeesUsd+0.03}})!;
  assert.equal(Number((before.estimatedNetPnlUsd-after.estimatedNetPnlUsd).toFixed(2)),0.23);
  assert.equal(estimateNetExitPnl({...position,unrealizedPnl:null}),null);
});

test("multiple same-market positions aggregate identically on widget and chart without showing one position's targets",()=>{
  const second = {...position,id:"p2",accountRef:"p2",side:"short" as const,unrealizedPnl:-0.2};
  const widget=buildWidgetServerSnapshot({agentPositions:[position],mainPositions:[second],mainAvailableUsdc:0,agentAvailableUsdc:0,session:null});
  assert.equal(widget.openPerpPnlUsd,summarizePositionOverlayEstimatedNetPnl([position,second]));
  assert.equal(widget.openPerpPnlPercent,summarizePositionOverlayEstimatedNetPnlPercent([position,second]));
  assert.equal(widget.openPerpSide,null);
  assert.equal(widget.openPerpTakeProfitPrice,null);
  assert.equal(widget.openPerpEntryPrice,null);
  assert.match(widget.openPerpLabel,/2 positions/);
});

test("delayed exit history and failed final notification are retried, never replaced with an older position's profit",async()=>{
  const now=Date.now();
  let state: StoredPerpsWatchState = {walletAddress:"owner",monitoredWalletAddress:"agent",lastCheckedAt:now-10000,
    snapshot:{positions:[position],pendingTriggers:[],recentTrades:[]}};
  let current: StoredPerpsWatchState["snapshot"] = {positions:[],pendingTriggers:[],recentTrades:[row("old","Close",304.46,now-100000)]};
  let deliveryWorks=false;
  const notices: string[]=[];
  const dependencies = {
    getPushConfigError:()=>null,
    listSubscribedWallets:async()=>["owner"], listNativeDevices:async()=>[],
    getWatchState:async()=>state,
    saveWatchState:async(next:StoredPerpsWatchState)=>{state=structuredClone(next);return next;},
    getAgentWallet:()=>"agent",fetchSnapshot:async()=>current,listExecutions:async()=>[],
    sendNotification:async(notification:{body:string})=>{
      notices.push(notification.body);
      return {sent:deliveryWorks?1:0,web:{sent:0,results:[]},native:{sent:deliveryWorks?1:0,results:[]}};
    },
  };
  await runPerpsTradeNotificationWatch(dependencies);
  assert.equal(state.pendingPnlClosures?.length,1);
  assert.equal(state.pendingPnlClosures?.[0]?.closingTxHash,null);
  assert.match(notices[0]!,/reconciling/);
  const close={...row("new","Close",304.46,now-2000),pnlAccounting:settlePnlReceipts("new",receipts,99.93,now)};
  current={...current,recentTrades:[close,...current.recentTrades]};
  await runPerpsTradeNotificationWatch(dependencies);
  assert.equal(state.pendingPnlClosures?.length,1,"failed push stays queued");
  deliveryWorks=true;
  await runPerpsTradeNotificationWatch(dependencies);
  assert.equal(state.pendingPnlClosures?.length,0);
  assert.match(notices.at(-1)!,/Realized net \+\$0\.39/);
  const count=notices.length;
  await runPerpsTradeNotificationWatch(dependencies);
  assert.equal(notices.length,count,"successful final push is not repeated");
});
