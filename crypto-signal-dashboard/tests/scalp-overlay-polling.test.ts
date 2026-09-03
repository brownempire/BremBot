import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createForegroundPoller } from "../lib/chart/foregroundPoller";

const flush = () => new Promise<void>(resolve=>setImmediate(resolve));
function setup(load: (signal: AbortSignal) => Promise<void>) {
  const timers = new Map<number,()=>void>();
  let id=0;
  const poller = createForegroundPoller({load,intervalMs:15000,
    schedule:(fn)=>{timers.set(++id,fn);return id as unknown as ReturnType<typeof setTimeout>;},
    cancel:(timer)=>{timers.delete(timer as unknown as number);},
  });
  return {poller,timers,tick:()=>{const entries=[...timers.values()];timers.clear();entries.forEach(fn=>fn());}};
}

test("hidden overlay does not load; foreground resumes immediately and hiding cancels its timer",async()=>{
  let calls=0;
  const {poller,timers,tick}=setup(async()=>{calls++;});
  poller.setActive(false);tick();await flush();assert.equal(calls,0);
  poller.setActive(true);await flush();assert.equal(calls,1);assert.equal(timers.size,1);
  poller.setActive(true);await flush();assert.equal(calls,1,"duplicate foreground event is not another fetch");
  tick();await flush();assert.equal(calls,2);
  poller.setActive(false);assert.equal(timers.size,0);tick();await flush();assert.equal(calls,2);
  poller.setActive(true);await flush();assert.equal(calls,3);
  poller.dispose();assert.equal(timers.size,0);
});

test("hiding aborts in-flight fetch and its late completion cannot restart polling",async()=>{
  const pending: {signal:AbortSignal;resolve:()=>void}[]=[];
  const {poller,timers}=setup(signal=>new Promise<void>(resolve=>pending.push({signal,resolve})));
  poller.setActive(true);assert.equal(timers.size,0,"no overlapping timer while waiting");
  poller.setActive(false);assert.equal(pending[0]!.signal.aborted,true);
  poller.setActive(true);assert.equal(pending.length,2);
  pending[0]!.resolve();await flush();assert.equal(timers.size,0,"old request cannot schedule a new timer");
  pending[1]!.resolve();await flush();assert.equal(timers.size,1);
  poller.dispose();poller.setActive(true);assert.equal(pending.length,2);
});

test("failed requests retry only while foregrounded",async()=>{
  let calls=0;
  const {poller,timers,tick}=setup(async()=>{calls++;throw new Error("offline");});
  poller.setActive(true);await flush();assert.equal(timers.size,1);
  poller.setActive(false);tick();await flush();assert.equal(calls,1);
  poller.dispose();
});

test("chart binds native/browser visibility and compact history stays outside autonomous trading",()=>{
  const source=readFileSync(new URL("../app/components/TradingViewChart.tsx",import.meta.url),"utf8");
  const history=readFileSync(new URL("../lib/chart/scalpOverlayHistory.ts",import.meta.url),"utf8");
  const monitor=readFileSync(new URL("../lib/perps/autonomousMonitor.ts",import.meta.url),"utf8");
  assert.match(source,/pageShown && nativeActive && document\.visibilityState === "visible"/);
  assert.match(source,/App\.addListener\("appStateChange"/);
  assert.match(source,/App\.getState\(\)/);
  assert.match(source,/window\.addEventListener\("pagehide",hide\)/);
  assert.match(source,/window\.removeEventListener\("pagehide",hide\)/);
  assert.match(source,/window\.addEventListener\("blur",blur\)/);
  assert.match(source,/!cancelled && !signal\.aborted/);
  assert.match(history,/#candidates > 20/);
  assert.match(history,/item\.walletAddress == wallet/);
  assert.match(history,/item\.asset == asset/);
  assert.match(history,/if cached then return/);
  assert.match(history,/'HSCAN'/);
  assert.doesNotMatch(history,/'HVALS'/,"never materialize the full history in the Redis script");
  assert.doesNotMatch(monitor,/createForegroundPoller|loadScalpOverlayHistory/);
  assert.match(monitor,/SCALP_ONE_SECOND_ENTRY_INTERVAL_MS = 1_000/);
});
