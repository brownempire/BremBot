"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";
import Image from "next/image";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import bs58 from "bs58";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@/app/components/SolanaWalletProvider";
import { isNativeIosRuntime, isNativeMacRuntime, isNativeShellRuntime, isStandalonePwaRuntime } from "@/app/lib/nativeShell";
import {
  remoteAuthSourceLabel,
  resolvePerpsRuntimePlatform,
  resolveRemoteSyncWalletAddress,
  type RemoteAuthSource,
} from "@/app/lib/walletRuntime";
import { syncWidgetSnapshot } from "@/app/lib/widgetSync";

import { JupiterTradePanel, type JupiterTradeRecord } from "@/app/components/JupiterTradePanel";
import { PerpsClockCard } from "@/app/components/perps-agent/PerpsClockCard";
import { PerpsExecutionFeed as PerpsAgentExecutionFeed } from "@/app/components/perps-agent/PerpsExecutionFeed";
import { PerpsSessionStatus } from "@/app/components/perps-agent/PerpsSessionStatus";
import { PerpsPnlChart } from "@/app/components/PerpsPnlChart";
import { SolanaWalletProvider } from "@/app/components/SolanaWalletProvider";
import { EmbeddedSimulatorPanel } from "@/app/components/EmbeddedSimulatorPanel";
import type {
  JupiterPerpsTpslModifier,
  JupiterPerpsWidgetController,
  JupiterPerpsWidgetSnapshot,
} from "@/app/components/JupiterPerpsPositionWidget";
import { TradingViewChart } from "@/app/components/TradingViewChart";
import {
  buildPositionOverlayGuides,
  summarizePositionOverlayPnl,
  type PositionOverlayGuide,
} from "@/lib/chart/positionOverlay";
import type { PerpsAutomationConfig } from "@/lib/perps/automationConfig";
import { OPERATOR_TRAINING_BASELINE } from "@/lib/decision/operatorTrainingBaselineConstants";
import { calculatePnlSince, type PerpsPnlPoint } from "@/lib/perps/pnl";
import { pnlPointsForRange } from "@/lib/perps/pnlChart";
import { SCALP_TRADE_LEVERAGE } from "@/lib/perps/scalpEngine";
import {
  DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT,
} from "@/lib/perps/scalpExit";
import { createSimulatedFeed } from "@/lib/price/simulated";
import type { PricePoint } from "@/lib/price/simulated";
import { detectSignals, type Signal, type UserParams } from "@/lib/signal/engine";
import { MAX_SIGNAL_HISTORY, normalizeSignalHistory, VISIBLE_SIGNAL_ROWS } from "@/lib/signal/history";
import { scrollAppToTop } from "@/lib/navigation/appScroll";
import { formatUsd } from "@/lib/utils";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETH_MINT = "7vfCXTUXx5WQXj6Yf8sTG6iM6Aq98J4A4P8M7P8yWfYw";
const BTC_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";
const PARAMS_STORAGE_KEY = "brembot.signal-params.v1";
const AUTO_TRADE_SETTINGS_STORAGE_KEY = "brembot.auto-trade-settings.v1";
const REMOTE_AUTH_TOKEN_STORAGE_KEY = "brembot.remote-trades-auth.v2";
const PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY = "brembot.perps-agent.local-session.v1";
const PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY = "brembot.perps-agent.local-executions.v1";
const PERPS_AGENT_LOCAL_DECISION_LOG_STORAGE_KEY = "brembot.perps-agent.local-decision-log.v1";
const PERPS_AGENT_LOCAL_LEARNING_PROFILE_STORAGE_KEY = "brembot.perps-agent.local-learning-profile.v1";
const PERPS_SESSION_TIMEOUT_MS = 60_000;
const IN_APP_REMOTE_AUTH_GRACE_MS = 20_000;
const LIVE_PRICE_REFRESH_MS = 15_000;
const LIVE_PRICE_MAX_BACKOFF_MS = 120_000;
const WALLET_PORTFOLIO_REFRESH_MS = 120_000;
const PERPS_HEARTBEAT_REFRESH_MS = 60_000;
const AUTOMATION_CONFIG_REFRESH_MS = 30_000;
const AI_PANEL_TOGGLE_EVENT = "bremlogic:ai-panel-toggle";
const AI_PANEL_STATE_EVENT = "bremlogic:ai-panel-state";
const NATIVE_ALERTS_ENABLED_STORAGE_KEY = "brembot.native-alerts-enabled.v1";
const DEFAULT_WALLET_PASSWORD = "bremlogic";
const LOCAL_RECENT_TRADES_CAP = 20;
const SIGNALS_BOT_TAB_EVENT = "bremlogic:signals-bot-tab-change";
const NATIVE_NOTIFICATION_SOUNDS = {
  signal: "brem_signal.wav",
  approval: "brem_approval.wav",
  tp: "brem_tp.wav",
  sl: "brem_sl.wav",
} as const;

type NativeNotificationSound = (typeof NATIVE_NOTIFICATION_SOUNDS)[keyof typeof NATIVE_NOTIFICATION_SOUNDS];

type TrackedMarket = {
  id: string;
  pair: string;
  coinbaseProduct: string;
  tvSymbol: string;
};

type MarketOption = {
  pair: string;
  coinbaseProduct: string;
  tvSymbol: string;
};

const DEFAULT_TRACKED_MARKETS: TrackedMarket[] = [
  { id: "slot-sol", pair: "SOL/USD", coinbaseProduct: "SOL-USD", tvSymbol: "COINBASE:SOLUSD" },
  { id: "slot-eth", pair: "ETH/USD", coinbaseProduct: "ETH-USD", tvSymbol: "COINBASE:ETHUSD" },
  { id: "slot-btc", pair: "BTC/USD", coinbaseProduct: "BTC-USD", tvSymbol: "COINBASE:BTCUSD" },
];

const JupiterPerpsPositionWidget = dynamic(
  () => import("@/app/components/JupiterPerpsPositionWidget").then((mod) => mod.JupiterPerpsPositionWidget),
  { ssr: false }
);

const DEFAULT_PARAMS: UserParams = {
  ...OPERATOR_TRAINING_BASELINE.signalParams,
};

type SignalsAppTab = "signals" | "perps" | "simulator" | "wallet";

type AutoTradeToken = "SOL" | "ETH" | "BTC" | "USDC" | "JUP" | "BONK";

type AutoTradeTokenOption = {
  symbol: AutoTradeToken;
  label: string;
  mint: string;
};

type AutoTradeMode = "all" | "buy-only";
type PerpsExecutionMode = "set-parameters" | "smart-trades";
type DecisionMode = "shadow" | "active";
type SmartTradeProfile = "conservative" | "balanced" | "aggressive";
type WalletAllocationMode = "percent" | "usd";
type TakeProfitMode = "percent" | "usd";

const AUTO_TRADE_TOKEN_OPTIONS: AutoTradeTokenOption[] = [
  { symbol: "SOL", label: "Solana (SOL)", mint: SOL_MINT },
  { symbol: "ETH", label: "Ethereum (ETH)", mint: ETH_MINT },
  { symbol: "BTC", label: "Bitcoin (BTC)", mint: BTC_MINT },
  { symbol: "USDC", label: "USDC", mint: USDC_MINT },
  { symbol: "JUP", label: "Jupiter (JUP)", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "BONK", label: "Bonk (BONK)", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
];

type AutoTradeSlot = {
  id: string;
  token: AutoTradeToken;
};

type AutoTradeSettings = {
  walletPercent: number;
  walletAllocationMode: WalletAllocationMode;
  perpsTakeProfitValue: number;
  perpsTakeProfitMode: TakeProfitMode;
  spotTakeProfitValue: number;
  spotTakeProfitMode: TakeProfitMode;
  stopLossPercent: number;
  perpsLeverage: number;
  perpsExecutionMode: PerpsExecutionMode;
  scalpModeEnabled: boolean;
  scalpTakeProfitRoePercent: number;
  decisionMode: DecisionMode;
  smartTradeProfile: SmartTradeProfile;
  slots: AutoTradeSlot[];
  activeSlotId: string | null;
  perpsActiveSlotId: string | null;
  mode: AutoTradeMode;
  disableTpLock: boolean;
};

type AutomationConfigSyncState = {
  walletAddress: string | null;
  revision: number;
  updatedAt: string | null;
  status: "idle" | "loading" | "ready" | "saving" | "synced" | "conflict" | "error";
  message: string;
};

const DEFAULT_AUTO_TRADE_SETTINGS: AutoTradeSettings = {
  walletPercent: OPERATOR_TRAINING_BASELINE.maximumAllocationPercent,
  walletAllocationMode: "percent",
  perpsTakeProfitValue: OPERATOR_TRAINING_BASELINE.takeProfitRoePercent,
  perpsTakeProfitMode: "percent",
  spotTakeProfitValue: 0,
  spotTakeProfitMode: "percent",
  stopLossPercent: OPERATOR_TRAINING_BASELINE.stopLossRoePercent,
  perpsLeverage: OPERATOR_TRAINING_BASELINE.leverageCap,
  perpsExecutionMode: "set-parameters",
  scalpModeEnabled: false,
  scalpTakeProfitRoePercent: DEFAULT_SCALP_TAKE_PROFIT_ROE_PERCENT,
  decisionMode: "active",
  smartTradeProfile: "balanced",
  slots: [
    { id: "auto-slot-1", token: "SOL" },
    { id: "auto-slot-2", token: "ETH" },
    { id: "auto-slot-3", token: "BTC" },
  ],
  activeSlotId: null,
  perpsActiveSlotId: null,
  mode: "all",
  disableTpLock: false,
};

function walletParamsStorageKey(walletAddress: string) {
  return `${PARAMS_STORAGE_KEY}:${walletAddress}`;
}

function walletAutoTradeSettingsStorageKey(walletAddress: string) {
  return `${AUTO_TRADE_SETTINGS_STORAGE_KEY}:${walletAddress}`;
}

function serializeAutomationConfig(settings: AutoTradeSettings, signalParams: UserParams) {
  return JSON.stringify({ settings, params: signalParams });
}

const PERPS_AUTO_TRADE_APPROVAL_TIMEOUT_MS = 60_000;
const AUTO_TRADE_ERROR_AUTO_RESET_MS = 20_000;
const ACTIVE_APPROVAL_TIMEOUT_MS = 20_000;

type WalletTokenHolding = {
  mint: string;
  amount: number;
  symbol?: string;
  name?: string;
  logoURI?: string | null;
  usdPrice?: number | null;
  usdValue?: number | null;
};

type StoredTradeRecord = {
  txid: string;
  timestamp: number;
  walletAddress?: string;
  inputMint?: string;
  outputMint?: string;
  inputAmount?: number;
  outputAmount?: number;
  id: string;
  source?: "manual" | "auto";
  signalId?: string;
  signalSummary?: string;
  symbol?: string;
  entryPrice?: number;
  takeProfitPrice?: number | null;
  tradeDirection?: "buy" | "sell";
  gasless?: boolean;
};

type PnlRange = "24h" | "7d" | "30d" | "ytd";
type PnlMode = "primary" | "agent";
type WalletBalanceMode = "main" | "agent";
type PerpsPnlPayload = {
  available: boolean;
  role: PnlMode;
  walletAddress?: string;
  historyComplete?: boolean;
  historyTotalCount?: number;
  points?: PerpsPnlPoint[];
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  totalPnlUsd?: number;
  tradeCount?: number;
  updatedAt?: number;
  message?: string;
};
type DashboardSectionId = "chart" | "wallet" | "perps" | "pnl" | "params" | "signals" | "trades";
type DashboardSectionLayout = {
  id: DashboardSectionId;
  width: number;
  height: number;
};
type PendingTakeProfit = {
  id: string;
  symbol: string;
  tokenSymbol: string;
  tokenMint: string;
  amount: number;
  entryPrice: number;
  targetPrice: number;
  signalId: string;
  createdAt: number;
};

type PendingPerpsApprovalRequest = {
  asset: "BTC" | "ETH" | "SOL";
  collateralToken: "BTC" | "ETH" | "SOL" | "USDC";
  leverage: string;
  maxSlippageBps?: string;
  side: "long" | "short";
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
  uiAmount: number;
};

type StoredPerpsApproval = {
  id: string;
  walletAddress: string;
  signalId: string;
  signalSummary: string;
  symbol: string;
  status: "pending" | "opened" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  request: PendingPerpsApprovalRequest;
  openedTxid?: string | null;
  failureReason?: string | null;
};

type PerpsExecutionSummary = {
  executionId: string;
  decisionId?: string | null;
  signalId: string;
  symbol: string;
  summary: string;
  market: string;
  side: "long" | "short";
  action: "open" | "close";
  sizeUsd: number;
  leverage: number;
  status: string;
  mode: "paper" | "live";
  executionModel: "approval-assisted" | "delegated-ready";
  reasonCode: string;
  reasonMessage: string;
  decisionConfidence?: number | null;
  decisionShouldTrade?: boolean;
  decisionSummary?: string | null;
  decisionTags?: string[];
  decisionShadowMode?: boolean;
  errorMessage?: string | null;
  createdAt: string;
  txid?: string | null;
  strategyClass?: "smart" | "scalp";
};

type DecisionLogEntry = {
  payload: {
    decisionId: string;
    createdAt: string;
    walletAddress: string;
    sessionId: string;
    sessionMode: "paper" | "live";
    executionModel: "approval-assisted" | "delegated-ready";
    signalId: string;
    symbol: string;
    summary: string;
    direction: "bullish" | "bearish";
    signalConfidence: number | null;
    asset: "SOL" | "ETH" | "BTC";
    strategyClass?: "smart" | "scalp";
    requestedTrade: {
      collateralUsd: number;
      leverage: number;
      takeProfitPrice: number | null;
      stopLossPrice: number | null;
      maxSlippageBps: number;
      executionStyle: "set-parameters" | "smart-trades" | null;
      smartTradeProfile: "conservative" | "balanced" | "aggressive" | null;
    };
    marketContext: {
      spotPrice: number | null;
      volatilityPercent: number | null;
      trendBias: "bullish" | "bearish" | "sideways" | null;
      availableUsdc: number | null;
      hasOpenPosition: boolean;
      recentPriceChangePercent: number | null;
    };
  };
  recommendation: {
    shouldTrade: boolean;
    confidenceScore: number;
    riskGrade: "low" | "medium" | "high";
    sizeMultiplier: number;
    leverageMultiplier: number;
    recommendedCollateralUsd: number;
    recommendedLeverage: number;
    recommendedTakeProfitPrice: number | null;
    recommendedStopLossPrice: number | null;
    explanationTags: string[];
    explanationSummary: string;
    shadowMode: boolean;
  };
};

type DecisionLearningProfile = {
  walletAddress: string;
  learnedAt: string;
  minimumConfidence: number;
  leverageCap: number;
  preferredDirection: "bullish" | "bearish" | "balanced";
  sizeMultiplier: number;
  summary: string;
  learnedFromEntries: number;
};

type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type PerpsSessionSnapshot = {
  sessionId: string;
  walletAddress: string;
  sessionState: "clocked_in" | "clocked_out";
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  inactiveSince?: string | null;
  endedAt: string | null;
  mode: "paper" | "live";
  executionModel: "approval-assisted" | "delegated-ready";
  appOpen: boolean;
  appForeground: boolean;
  walletConnected: boolean;
  walletWriteEnabled: boolean;
  killSwitch: boolean;
  unlimitedSession: boolean;
  platform: "native" | "web" | "pwa" | null;
  walletProvider: string | null;
  warning: string | null;
};

type SmartPerpsTradePlan = {
  collateralPercent: number;
  leverage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  volatilityPercent: number;
};

type RemoteAuthChallenge = {
  address: string;
  challengeId: string;
  message: string;
  expiresInSeconds: number;
  expiresAt: string;
};

type StepperNumberInputProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  inputMode?: "decimal" | "numeric";
  onChange: (value: number) => void;
};

function countStepDecimals(step: number) {
  const raw = step.toString();
  if (!raw.includes(".")) return 0;
  return raw.split(".")[1]?.length ?? 0;
}

function clampToRange(value: number, min?: number, max?: number) {
  if (typeof min === "number") value = Math.max(min, value);
  if (typeof max === "number") value = Math.min(max, value);
  return value;
}

function getMintForToken(token: "SOL" | "ETH" | "BTC") {
  if (token === "SOL") return SOL_MINT;
  if (token === "ETH") return ETH_MINT;
  return BTC_MINT;
}

function getPublicPerpsLiveAllowedWallets() {
  return (process.env.NEXT_PUBLIC_PERPS_LIVE_ALLOWED_WALLETS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isPublicPerpsLiveWalletAllowed(walletAddress: string | null | undefined) {
  if (!walletAddress) return false;
  const allowed = getPublicPerpsLiveAllowedWallets();
  if (allowed.length === 0) return false;
  return allowed.includes(walletAddress.trim());
}

function loadLocalPerpsAgentSession() {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      window.localStorage.getItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY)
      ?? window.sessionStorage.getItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as PerpsSessionSnapshot;
    if (session?.sessionState !== "clocked_in") {
      return session;
    }

    const now = Date.now();
    const inactiveSince = session.inactiveSince ? Date.parse(session.inactiveSince) : null;
    const lastHeartbeatAt = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : null;
    const timedOutWhileInactive =
      Number.isFinite(inactiveSince)
        ? now - Number(inactiveSince) >= PERPS_SESSION_TIMEOUT_MS
        : false;
    const timedOutHeartbeat =
      !Number.isFinite(inactiveSince)
      && Number.isFinite(lastHeartbeatAt)
      && now - Number(lastHeartbeatAt) >= PERPS_SESSION_TIMEOUT_MS;

    if (timedOutWhileInactive || timedOutHeartbeat) {
      window.localStorage.removeItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY);
      window.sessionStorage.removeItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY);
      return null;
    }

    window.localStorage.setItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY, raw);
    window.sessionStorage.removeItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY);
    return session;
  } catch {
    return null;
  }
}

function saveLocalPerpsAgentSession(session: PerpsSessionSnapshot | null) {
  if (typeof window === "undefined") return;
  try {
    if (!session) {
      window.localStorage.removeItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY);
      window.sessionStorage.removeItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY, JSON.stringify(session));
    window.sessionStorage.removeItem(PERPS_AGENT_LOCAL_SESSION_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function loadLocalPerpsAgentExecutions() {
  if (typeof window === "undefined") return [] as PerpsExecutionSummary[];
  try {
    const raw = window.localStorage.getItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY)
      ?? window.sessionStorage.getItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PerpsExecutionSummary[];
    window.localStorage.setItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY, raw);
    window.sessionStorage.removeItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalPerpsAgentExecutions(executions: PerpsExecutionSummary[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY, JSON.stringify(executions));
    window.sessionStorage.removeItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function getWalletScopedStorageKey(walletAddress: string | null | undefined) {
  return walletAddress?.trim() || "paper-auto";
}

function loadLocalDecisionLogStore() {
  if (typeof window === "undefined") return {} as Record<string, DecisionLogEntry[]>;
  try {
    const raw = window.localStorage.getItem(PERPS_AGENT_LOCAL_DECISION_LOG_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DecisionLogEntry[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {} as Record<string, DecisionLogEntry[]>;
  }
}

function saveLocalDecisionLogStore(store: Record<string, DecisionLogEntry[]>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERPS_AGENT_LOCAL_DECISION_LOG_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage failures
  }
}

function loadLocalDecisionLogEntries(walletAddress: string | null | undefined) {
  if (typeof window === "undefined") return [] as DecisionLogEntry[];
  try {
    const raw = window.localStorage.getItem(PERPS_AGENT_LOCAL_DECISION_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, DecisionLogEntry[]>;
    const walletKey = getWalletScopedStorageKey(walletAddress);
    const entries = parsed?.[walletKey];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [] as DecisionLogEntry[];
  }
}

function saveLocalDecisionLogEntries(walletAddress: string | null | undefined, entries: DecisionLogEntry[]) {
  if (typeof window === "undefined") return;
  try {
    const walletKey = getWalletScopedStorageKey(walletAddress);
    const store = loadLocalDecisionLogStore();
    store[walletKey] = entries;
    window.localStorage.setItem(PERPS_AGENT_LOCAL_DECISION_LOG_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage failures
  }
}

function loadLocalLearningProfileStore() {
  if (typeof window === "undefined") return {} as Record<string, DecisionLearningProfile>;
  try {
    const raw = window.localStorage.getItem(PERPS_AGENT_LOCAL_LEARNING_PROFILE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, DecisionLearningProfile>;
    return parsed && typeof parsed === "object" ? parsed as Record<string, DecisionLearningProfile> : {};
  } catch {
    return {} as Record<string, DecisionLearningProfile>;
  }
}

function loadLocalLearningProfile(walletAddress: string | null | undefined) {
  const store = loadLocalLearningProfileStore();
  return store[getWalletScopedStorageKey(walletAddress)] ?? null;
}

function saveLocalLearningProfile(profile: DecisionLearningProfile) {
  if (typeof window === "undefined") return;
  try {
    const store = loadLocalLearningProfileStore();
    store[getWalletScopedStorageKey(profile.walletAddress)] = profile;
    window.localStorage.setItem(PERPS_AGENT_LOCAL_LEARNING_PROFILE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore storage failures
  }
}

function normalizeStepValue(value: number, step: number, min?: number, max?: number) {
  const decimals = countStepDecimals(step);
  return Number(clampToRange(value, min, max).toFixed(decimals));
}

function StepperNumberInput({
  value,
  min,
  max,
  step = 1,
  inputMode = "decimal",
  onChange,
}: StepperNumberInputProps) {
  const applyValue = (next: number, snapToStep = false) => {
    if (!Number.isFinite(next)) return;
    onChange(snapToStep ? normalizeStepValue(next, step, min, max) : clampToRange(next, min, max));
  };

  return (
    <div className="stepper-input">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        inputMode={inputMode}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          applyValue(next);
        }}
      />
      <div className="stepper-input-buttons">
        <button type="button" aria-label="Increase value" onClick={() => applyValue(value + step, true)}>▲</button>
        <button type="button" aria-label="Decrease value" onClick={() => applyValue(value - step, true)}>▼</button>
      </div>
    </div>
  );
}

function formatAllocationValue(settings: AutoTradeSettings) {
  if (settings.walletAllocationMode === "usd") {
    return `$${settings.walletPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  return `${settings.walletPercent.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

function getAllocationPercentOfBalance(settings: AutoTradeSettings, balanceAmount: number) {
  if (settings.walletAllocationMode === "usd") {
    if (!Number.isFinite(balanceAmount) || balanceAmount <= 0) return 0;
    return clampNumber((settings.walletPercent / balanceAmount) * 100, 0, 100);
  }
  return clampNumber(settings.walletPercent, 1, 100);
}

function getAutoTradeAllocationAmount(options: {
  settings: AutoTradeSettings;
  availableInput: number;
  inputMint: string;
  assetUsdPrice?: number | null;
}) {
  const { settings, availableInput, inputMint, assetUsdPrice } = options;
  if (!Number.isFinite(availableInput) || availableInput <= 0) return 0;
  if (settings.walletAllocationMode === "percent") {
    return Number((availableInput * (settings.walletPercent / 100)).toFixed(6));
  }
  if (inputMint === USDC_MINT) {
    return Number(Math.min(availableInput, settings.walletPercent).toFixed(6));
  }
  if (!Number.isFinite(assetUsdPrice) || !assetUsdPrice || assetUsdPrice <= 0) return 0;
  return Number(Math.min(availableInput, settings.walletPercent / assetUsdPrice).toFixed(6));
}

function formatAutoTradeAllocationLabel(settings: AutoTradeSettings, kind: "allocation" | "collateral" = "allocation") {
  return `${formatAllocationValue(settings)} ${kind}`;
}

function computeSpotTakeProfitTargetPrice(options: {
  entryPrice: number;
  amount: number;
  mode: TakeProfitMode;
  value: number;
}) {
  if (!Number.isFinite(options.entryPrice) || options.entryPrice <= 0) return null;
  if (!Number.isFinite(options.value) || options.value <= 0) return null;

  if (options.mode === "percent") {
    return options.entryPrice * (1 + (options.value / 100));
  }

  if (!Number.isFinite(options.amount) || options.amount <= 0) return null;
  return options.entryPrice + (options.value / options.amount);
}

function computePerpsTakeProfitTargetPrice(options: {
  entryPrice: number;
  side: "long" | "short";
  positionSizeUsd: number;
  mode: TakeProfitMode;
  value: number;
}) {
  if (!Number.isFinite(options.entryPrice) || options.entryPrice <= 0) return null;
  if (!Number.isFinite(options.value) || options.value <= 0) return null;

  if (options.mode === "percent") {
    return options.side === "long"
      ? options.entryPrice * (1 + (options.value / 100))
      : options.entryPrice * (1 - (options.value / 100));
  }

  if (!Number.isFinite(options.positionSizeUsd) || options.positionSizeUsd <= 0) return null;
  const moveFraction = options.value / options.positionSizeUsd;
  return options.side === "long"
    ? options.entryPrice * (1 + moveFraction)
    : options.entryPrice * (1 - moveFraction);
}

function formatTakeProfitSetting(mode: TakeProfitMode, value: number) {
  if (!Number.isFinite(value) || value <= 0) return "off";
  return mode === "percent" ? `+${value}%` : `+${formatUsd(value)}`;
}

type PhantomAuthProvider = {
  isPhantom?: boolean;
  publicKey?: PublicKey | { toBase58: () => string } | null;
  isConnected?: boolean;
  connect: (options?: Record<string, unknown>) => Promise<{ publicKey?: PublicKey | { toBase58: () => string } } | void>;
  disconnect?: () => Promise<void>;
  signMessage: (
    message: Uint8Array,
    display?: "utf8" | "hex"
  ) => Promise<{ signature?: Uint8Array } | Uint8Array>;
};

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function shortAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function deriveFeeAdjustedPerpsTriggers(options: {
  desiredStopLossPercent: number;
  desiredTakeProfitPercent: number;
  fallbackEntryPrice: number;
  preview: {
    pool: {
      openFeePercent: number | null;
    };
    quote: {
      averagePriceUsd: number | null;
      openFeeUsd: number | null;
      outstandingBorrowFeeUsd: number | null;
      positionSizeUsd: number | null;
      priceImpactFeeUsd: number | null;
    };
    side: "long" | "short";
  };
}) {
  const desiredTakeProfitFraction = options.desiredTakeProfitPercent > 0 ? options.desiredTakeProfitPercent / 100 : 0;
  const desiredStopLossFraction = options.desiredStopLossPercent > 0 ? options.desiredStopLossPercent / 100 : 0;
  const entryPrice =
    typeof options.preview.quote.averagePriceUsd === "number" && Number.isFinite(options.preview.quote.averagePriceUsd) && options.preview.quote.averagePriceUsd > 0
      ? options.preview.quote.averagePriceUsd
      : options.fallbackEntryPrice;
  const positionSizeUsd = options.preview.quote.positionSizeUsd;
  const openFeeUsd = options.preview.quote.openFeeUsd ?? 0;
  const priceImpactFeeUsd = options.preview.quote.priceImpactFeeUsd ?? 0;
  const outstandingBorrowFeeUsd = options.preview.quote.outstandingBorrowFeeUsd ?? 0;
  const openFeePercent = options.preview.pool.openFeePercent;
  const estimatedCloseFeeUsd =
    typeof positionSizeUsd === "number" &&
    Number.isFinite(positionSizeUsd) &&
    positionSizeUsd > 0 &&
    typeof openFeePercent === "number" &&
    Number.isFinite(openFeePercent) &&
    openFeePercent > 0
      ? positionSizeUsd * (openFeePercent / 100)
      : openFeeUsd;
  const estimatedRoundTripFeesUsd = openFeeUsd + priceImpactFeeUsd + outstandingBorrowFeeUsd + estimatedCloseFeeUsd;
  const feeMoveFraction =
    typeof positionSizeUsd === "number" && Number.isFinite(positionSizeUsd) && positionSizeUsd > 0
      ? estimatedRoundTripFeesUsd / positionSizeUsd
      : 0;

  const takeProfitMoveFraction = desiredTakeProfitFraction > 0 ? desiredTakeProfitFraction + feeMoveFraction : 0;
  const stopLossMoveFraction = desiredStopLossFraction > 0 ? Math.max(0, desiredStopLossFraction - feeMoveFraction) : 0;

  const takeProfitPrice =
    takeProfitMoveFraction > 0
      ? options.preview.side === "long"
        ? entryPrice * (1 + takeProfitMoveFraction)
        : entryPrice * (1 - takeProfitMoveFraction)
      : null;
  const stopLossPrice =
    stopLossMoveFraction > 0 || desiredStopLossFraction > 0
      ? options.preview.side === "long"
        ? entryPrice * (1 - stopLossMoveFraction)
        : entryPrice * (1 + stopLossMoveFraction)
      : null;

  return {
    entryPrice,
    estimatedRoundTripFeesUsd,
    stopLossPrice: typeof stopLossPrice === "number" && Number.isFinite(stopLossPrice) ? stopLossPrice : null,
    takeProfitPrice: typeof takeProfitPrice === "number" && Number.isFinite(takeProfitPrice) ? takeProfitPrice : null,
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function computeRecentVolatilityPercent(points: PricePoint[]) {
  const valid = points.filter((point) => Number.isFinite(point.v) && point.v > 0);
  if (valid.length < 2) return 0;
  const recent = valid.slice(-Math.min(60, valid.length));
  const values = recent.map((point) => point.v);
  const high = Math.max(...values);
  const low = Math.min(...values);
  const last = recent[recent.length - 1]?.v ?? high;
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(last) || last <= 0) return 0;
  return ((high - low) / last) * 100;
}

function computeRecentTrendBias(points: PricePoint[]): "bullish" | "bearish" | "sideways" {
  const valid = points.filter((point) => Number.isFinite(point.v) && point.v > 0);
  if (valid.length < 2) return "sideways";
  const recent = valid.slice(-Math.min(20, valid.length));
  const first = recent[0]?.v ?? 0;
  const last = recent[recent.length - 1]?.v ?? 0;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) {
    return "sideways";
  }
  const changePercent = ((last - first) / first) * 100;
  if (changePercent >= 1) return "bullish";
  if (changePercent <= -1) return "bearish";
  return "sideways";
}

function deriveSmartPerpsTradePlan(options: {
  points: PricePoint[];
  settings: AutoTradeSettings;
  collateralPercentBase: number;
  signal: Signal;
}): SmartPerpsTradePlan {
  const volatilityPercent = computeRecentVolatilityPercent(options.points);
  const volatilityFactor = clampNumber(volatilityPercent / 2.5, 0, 1.35);
  const confidenceBias = clampNumber((options.signal.confidence - 0.55) / 0.35, -0.5, 1);
  const profile = options.settings.smartTradeProfile;

  const profileSettings: Record<SmartTradeProfile, {
    collateralBase: number;
    leverageBase: number;
    defaultTp: number;
    leverageCapMultiplier: number;
  }> = {
    conservative: {
      collateralBase: 0.4,
      leverageBase: 0.3,
      defaultTp: 0.9,
      leverageCapMultiplier: 0.45,
    },
    balanced: {
      collateralBase: 0.65,
      leverageBase: 0.5,
      defaultTp: 1.5,
      leverageCapMultiplier: 0.65,
    },
    aggressive: {
      collateralBase: 0.8,
      leverageBase: 1.35,
      defaultTp: 3,
      leverageCapMultiplier: 2,
    },
  };

  const profileConfig = profileSettings[profile];
  const smartTradeBaseLeverage = OPERATOR_TRAINING_BASELINE.leverageCap;
  const collateralPercent = clampNumber(
    options.collateralPercentBase * (profileConfig.collateralBase + confidenceBias * 0.18 - volatilityFactor * 0.16),
    5,
    100
  );
  const leverage = clampNumber(
    smartTradeBaseLeverage * (profileConfig.leverageBase + confidenceBias * 0.12 - volatilityFactor * 0.14),
    1,
    Math.min(250, Math.max(1, smartTradeBaseLeverage * profileConfig.leverageCapMultiplier))
  );
  const baseTp = options.settings.perpsTakeProfitMode === "percent" && options.settings.perpsTakeProfitValue > 0
    ? options.settings.perpsTakeProfitValue
    : profileConfig.defaultTp;
  const takeProfitPercent = clampNumber(
    baseTp * (1 + volatilityFactor * 0.28 + confidenceBias * 0.08),
    0.2,
    6
  );
  const stopLossPercent = OPERATOR_TRAINING_BASELINE.stopLossRoePercent;

  return {
    collateralPercent: Number(collateralPercent.toFixed(0)),
    leverage: Number(leverage.toFixed(2)),
    stopLossPercent: Number(stopLossPercent.toFixed(2)),
    takeProfitPercent: Number(takeProfitPercent.toFixed(2)),
    volatilityPercent: Number(volatilityPercent.toFixed(2)),
  };
}

function formatFeedSource(status: string) {
  const map: Record<string, string> = {
    loading: "loading",
    offline: "offline",
    simulated: "Simulated",
    chaos_edge: "Chaos Edge",
    coinbase: "Coinbase",
    coingecko: "CoinGecko",
  };
  return map[status] ?? status;
}

function tradesStorageKey(walletAddress: string) {
  return `brembot.recent-trades.${walletAddress}`;
}

function signalsStorageKey(walletAddress: string) {
  return `brembot.recent-signals.${walletAddress}`;
}

function remoteTradesAuthStorageKey(walletAddress: string) {
  return `${REMOTE_AUTH_TOKEN_STORAGE_KEY}.${walletAddress}`;
}

function isNativeShellApp() {
  return isNativeShellRuntime();
}

function readNativeAlertsEnabled() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(NATIVE_ALERTS_ENABLED_STORAGE_KEY) === "true";
}

function writeNativeAlertsEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NATIVE_ALERTS_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
}

function getNativePushPluginStatus() {
  return {
    hasLocalNotifications: Capacitor.isPluginAvailable("LocalNotifications"),
    hasPushNotifications: Capacitor.isPluginAvailable("PushNotifications"),
  };
}

function getPhantomAuthProvider(): PhantomAuthProvider | null {
  if (typeof window === "undefined") return null;
  const candidate =
    (window as typeof window & { phantom?: { solana?: PhantomAuthProvider }; solana?: PhantomAuthProvider }).phantom
      ?.solana
      ?? (window as typeof window & { solana?: PhantomAuthProvider }).solana;
  if (!candidate?.isPhantom || typeof candidate.connect !== "function" || typeof candidate.signMessage !== "function") {
    return null;
  }
  return candidate;
}

function extractPhantomPublicKey(provider: PhantomAuthProvider) {
  const key = provider.publicKey;
  if (!key) return null;
  return typeof key.toBase58 === "function" ? key.toBase58() : null;
}

const DASHBOARD_LAYOUT_STORAGE_KEY = "brembot.dashboard.layout.v1";
const POSITION_OVERLAY_STORAGE_KEY = "brembot.tradingview.position-overlay.v1";
const SCALP_OVERLAY_STORAGE_KEY = "brembot.tradingview.scalp-agent-overlay.v1";
const DEFAULT_DASHBOARD_LAYOUT: DashboardSectionLayout[] = [
  { id: "chart", width: 1080, height: 640 },
  { id: "wallet", width: 1080, height: 520 },
  { id: "perps", width: 1080, height: 620 },
  { id: "pnl", width: 1080, height: 460 },
  { id: "params", width: 1080, height: 500 },
  { id: "signals", width: 1080, height: 430 },
  { id: "trades", width: 1080, height: 500 },
];

const DASHBOARD_SECTION_TITLES: Record<DashboardSectionId, string> = {
  chart: "TradingView Chart",
  wallet: "In-App Wallet",
  perps: "Jupiter Perps",
  pnl: "PnL",
  params: "Signal Parameters",
  signals: "Live Signals",
  trades: "Recent Trades",
};

function getAutoTradeTokenOption(symbol: AutoTradeToken) {
  return AUTO_TRADE_TOKEN_OPTIONS.find((option) => option.symbol === symbol) ?? AUTO_TRADE_TOKEN_OPTIONS[0];
}

function normalizeMarketGuideKey(value: string | null | undefined) {
  const raw = value?.trim().toUpperCase() ?? "";
  if (!raw) return null;
  if (raw.includes("SOL")) return "SOL";
  if (raw.includes("ETH")) return "ETH";
  if (raw.includes("BTC")) return "BTC";
  return null;
}

function isSupportedPerpsAutoTradeToken(symbol: AutoTradeToken): symbol is "SOL" | "ETH" | "BTC" {
  return symbol === "SOL" || symbol === "ETH" || symbol === "BTC";
}

function isPerpsBuildFailureMessage(message: string) {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("could not build the order") ||
    normalized.includes("unable to build the jupiter perps order") ||
    normalized.includes("internal server error") ||
    normalized.includes("jupiter support")
  );
}

function DashboardPage() {
  const router = useRouter();
  const { connection } = useConnection();
  const wallet = useWallet();
  const walletAddress = wallet.publicKey?.toBase58() ?? null;
  const walletExecuteSwap = wallet.executeSwap;
  const walletPublicKey = wallet.publicKey;
  const walletSignMessage = wallet.signMessage;

  const [trackedMarkets, setTrackedMarkets] = useState<TrackedMarket[]>(DEFAULT_TRACKED_MARKETS);
  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({});
  const [dayChange24h, setDayChange24h] = useState<Record<string, number>>({});
  const [params, setParams] = useState<UserParams>(DEFAULT_PARAMS);
  const [paramsSaveStatus, setParamsSaveStatus] = useState("Using defaults");
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastSignalAt, setLastSignalAt] = useState<Record<string, number>>({});
  const [selectedChartSlotId, setSelectedChartSlotId] = useState<string>(DEFAULT_TRACKED_MARKETS[0].id);
  const [positionOverlayEnabled, setPositionOverlayEnabled] = useState(true);
  const [scalpOverlayEnabled, setScalpOverlayEnabled] = useState(false);
  const [receiveSignalsForSlotId, setReceiveSignalsForSlotId] = useState<string>(DEFAULT_TRACKED_MARKETS[0].id);
  const [priceFeedStatus, setPriceFeedStatus] = useState("loading");
  const [marketOptions, setMarketOptions] = useState<MarketOption[]>(DEFAULT_TRACKED_MARKETS);
  const [editingSignalTarget, setEditingSignalTarget] = useState(false);

  const [pushStatus, setPushStatus] = useState("Push not enabled");
  const [pushReady, setPushReady] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscriptionJSON | null>(null);
  const [nativePushToken, setNativePushToken] = useState<string | null>(null);
  const [nativePushIssue, setNativePushIssue] = useState<string | null>(null);
  const [activeApprovalId, setActiveApprovalId] = useState<string | null>(null);
  const [activeApprovalStatus, setActiveApprovalStatus] = useState<string | null>(null);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [walletTokens, setWalletTokens] = useState<WalletTokenHolding[]>([]);
  const [totalBalanceUsd, setTotalBalanceUsd] = useState<number | null>(null);
  const [solValueUsd, setSolValueUsd] = useState<number | null>(null);
  const [portfolioStatus, setPortfolioStatus] = useState("Wallet not connected");
  const [walletBalanceMode, setWalletBalanceMode] = useState<WalletBalanceMode>("main");
  const [walletBalanceMenuOpen, setWalletBalanceMenuOpen] = useState(false);
  const [agentSolBalance, setAgentSolBalance] = useState<number | null>(null);
  const [agentWalletTokens, setAgentWalletTokens] = useState<WalletTokenHolding[]>([]);
  const [agentTotalBalanceUsd, setAgentTotalBalanceUsd] = useState<number | null>(null);
  const [agentSolValueUsd, setAgentSolValueUsd] = useState<number | null>(null);
  const [agentPortfolioWalletAddress, setAgentPortfolioWalletAddress] = useState<string | null>(null);
  const [agentPortfolioStatus, setAgentPortfolioStatus] = useState("Agent wallet not associated");
  const [recentTrades, setRecentTrades] = useState<StoredTradeRecord[]>([]);
  const [autoTradeStatus, setAutoTradeStatus] = useState("Auto-trade is off");
  const [perpsAutoTradeStatus, setPerpsAutoTradeStatus] = useState("Perps auto-trade is off");
  const [perpsAgentSession, setPerpsAgentSession] = useState<PerpsSessionSnapshot | null>(null);
  const [perpsAgentExecutions, setPerpsAgentExecutions] = useState<PerpsExecutionSummary[]>([]);
  const [perpsSessionBusy, setPerpsSessionBusy] = useState(false);
  const [perpsSessionModePreference, setPerpsSessionModePreference] = useState<"paper" | "live">("paper");
  const [perpsUnlimitedSession, setPerpsUnlimitedSession] = useState(false);
  const [decisionLogOpen, setDecisionLogOpen] = useState(false);
  const [decisionLogContent, setDecisionLogContent] = useState("Loading decision log...");
  const [decisionLogBusy, setDecisionLogBusy] = useState(false);
  const [decisionLogEntries, setDecisionLogEntries] = useState<DecisionLogEntry[]>([]);
  const [decisionLogExecutionHistory, setDecisionLogExecutionHistory] = useState<PerpsExecutionSummary[]>([]);
  const [decisionLearningBusy, setDecisionLearningBusy] = useState(false);
  const [decisionLearningStatus, setDecisionLearningStatus] = useState("Train the wallet-specific agent profile from saved decision history.");
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiChatMessages, setAiChatMessages] = useState<AiChatMessage[]>([]);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState("Ask AI to explain the current move.");
  const [autoTradeSettings, setAutoTradeSettings] = useState<AutoTradeSettings>(DEFAULT_AUTO_TRADE_SETTINGS);
  const [pendingTakeProfit, setPendingTakeProfit] = useState<PendingTakeProfit | null>(null);
  const [readOnlyPerpsSnapshot, setReadOnlyPerpsSnapshot] = useState<JupiterPerpsWidgetSnapshot>({
    agentWalletAddress: null,
    agentAvailableUsdc: null,
    walletAddress: null,
    positions: [],
    pendingTriggers: [],
    recentTrades: [],
    isLoading: false,
    error: null,
    isMock: false,
    connected: false,
  });
  const [jupiterPerpsController, setJupiterPerpsController] = useState<JupiterPerpsWidgetController | null>(null);
  const [showAutoTradeSelectorWarning, setShowAutoTradeSelectorWarning] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [pnlRange, setPnlRange] = useState<PnlRange>("24h");
  const [pnlMode, setPnlMode] = useState<PnlMode>("primary");
  const [pnlStatus, setPnlStatus] = useState("Connect the Main wallet to load Perps PnL.");
  const [remoteAuthSource, setRemoteAuthSource] = useState<RemoteAuthSource | null>(null);
  const [remoteAuthStatus, setRemoteAuthStatus] = useState("Remote auth pending");
  const [remoteSyncStatus, setRemoteSyncStatus] = useState("Remote sync idle");
  const [remoteAuthToken, setRemoteAuthToken] = useState<string | null>(null);
  const [remoteAuthAddress, setRemoteAuthAddress] = useState<string | null>(null);
  const [phantomAuthAddress, setPhantomAuthAddress] = useState<string | null>(null);
  const [perpsPnlByRole, setPerpsPnlByRole] = useState<Record<PnlMode, PerpsPnlPayload | null>>({ primary: null, agent: null });
  const [renderNow, setRenderNow] = useState(0);
  const [nativeShell, setNativeShell] = useState(false);
  const [nativeMacShell, setNativeMacShell] = useState(false);
  const [standalonePwa, setStandalonePwa] = useState(false);
  const [localAutomationSettingsLoaded, setLocalAutomationSettingsLoaded] = useState(false);
  const [automationConfigSync, setAutomationConfigSync] = useState<AutomationConfigSyncState>({
    walletAddress: null,
    revision: 0,
    updatedAt: null,
    status: "idle",
    message: "Authenticate a wallet to sync master controls.",
  });
  const [dashboardLayout, setDashboardLayout] = useState<DashboardSectionLayout[]>(DEFAULT_DASHBOARD_LAYOUT);
  const [dragSectionId, setDragSectionId] = useState<DashboardSectionId | null>(null);
  const resizeStateRef = useRef<{
    id: DashboardSectionId;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const autoTradeBusyRef = useRef(false);
  const perpsAutoTradeBusyRef = useRef(false);
  const autoTradeSettingsRef = useRef(autoTradeSettings);
  const paramsRef = useRef(params);
  const automationConfigSyncRef = useRef(automationConfigSync);
  const syncedAutomationSnapshotRef = useRef<string | null>(null);
  const pendingTakeProfitRef = useRef<PendingTakeProfit | null>(null);
  const readOnlyPerpsSnapshotRef = useRef<JupiterPerpsWidgetSnapshot>({
    agentWalletAddress: null,
    agentAvailableUsdc: null,
    walletAddress: null,
    positions: [],
    pendingTriggers: [],
    recentTrades: [],
    isLoading: false,
    error: null,
    isMock: false,
    connected: false,
  });
  const chartTpslModifierRef = useRef<JupiterPerpsTpslModifier | null>(null);
  const lastTpAttemptAtRef = useRef(0);
  const perpsAutoTradeAttemptIdRef = useRef(0);
  const perpsAutoTradeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const perpsAutoTradeErrorResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const perpsAutoTradeFailureCooldownUntilRef = useRef(0);
  const wakeLockRef = useRef<{ release?: () => Promise<void> } | null>(null);
  const approvalConnectStartedRef = useRef<string | null>(null);
  const approvalExecutionStartedRef = useRef<string | null>(null);
  const activeApprovalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteAuthDisconnectTimeoutRef = useRef<number | null>(null);
  const lastWidgetSyncAtRef = useRef(0);
  const lastWidgetSyncSignatureRef = useRef("");
  const activeAutoTradeSlot = useMemo(
    () => autoTradeSettings.slots.find((slot) => slot.id === autoTradeSettings.activeSlotId) ?? null,
    [autoTradeSettings.activeSlotId, autoTradeSettings.slots]
  );
  const activePerpsAutoTradeSlot = useMemo(
    () => autoTradeSettings.slots.find((slot) => slot.id === autoTradeSettings.perpsActiveSlotId) ?? null,
    [autoTradeSettings.perpsActiveSlotId, autoTradeSettings.slots]
  );
  const activeAutoTradeToken = activeAutoTradeSlot ? getAutoTradeTokenOption(activeAutoTradeSlot.token) : null;
  const activePerpsAutoTradeToken = activePerpsAutoTradeSlot ? getAutoTradeTokenOption(activePerpsAutoTradeSlot.token) : null;
  const latestSignal = signals[0] ?? null;
  const autoTradeEnabled = Boolean(activeAutoTradeToken);
  const perpsAutoTradeEnabled = Boolean(activePerpsAutoTradeToken);
  const nativeWalletShell = nativeShell || nativeMacShell;
  const remoteSyncWalletAddress = resolveRemoteSyncWalletAddress({
    source: remoteAuthSource,
    walletConnectAddress: jupiterPerpsController?.walletAddress ?? null,
    inAppAddress: walletAddress,
    phantomAddress: phantomAuthAddress,
    remoteAuthAddress,
  });
  const tradeStorageAddress =
    remoteAuthSource === "walletconnect"
      ? jupiterPerpsController?.walletAddress ?? remoteAuthAddress ?? "paper-auto"
      : remoteAuthSource === "phantom"
        ? phantomAuthAddress ?? walletAddress ?? "paper-auto"
        : walletAddress ?? "paper-auto";
  const signalStorageAddress = remoteSyncWalletAddress ?? tradeStorageAddress;
  const automationConfigSyncLabel = automationConfigSync.walletAddress
    ? `${automationConfigSync.message} · ${shortAddress(automationConfigSync.walletAddress)}${automationConfigSync.revision > 0 ? ` · revision ${automationConfigSync.revision}` : ""}${automationConfigSync.updatedAt ? ` · ${new Date(automationConfigSync.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`
    : automationConfigSync.message;
  const [activeSignalsTab, setActiveSignalsTab] = useState<SignalsAppTab>("signals");
  const perpsWalletConnected = Boolean(jupiterPerpsController?.connected || wallet.connected);
  const perpsConnectionLabel: "Disconnected" | "Connected" = perpsWalletConnected ? "Connected" : "Disconnected";
  const perpsSessionStateLabel: "Clocked In" | "Clocked Out" =
    perpsAgentSession?.sessionState === "clocked_in" ? "Clocked In" : "Clocked Out";
  const perpsModeLabel: "Paper mode" | "Live mode" =
    (perpsAgentSession?.mode ?? perpsSessionModePreference) === "live" ? "Live mode" : "Paper mode";
  const perpsLiveEligibleWallet =
    jupiterPerpsController?.walletAddress ?? walletAddress ?? remoteSyncWalletAddress;
  const perpsLiveWalletAllowed = isPublicPerpsLiveWalletAllowed(perpsLiveEligibleWallet);
  const perpsRuntimePlatform = resolvePerpsRuntimePlatform({ nativeShell, nativeMacShell, standalonePwa });
  const perpsPlatformLabel =
    nativeWalletShell
      ? "Native app"
      : perpsAgentSession?.platform === "native"
        ? "Native app"
        : perpsAgentSession?.platform === "pwa"
          ? "PWA"
          : perpsAgentSession?.platform === "web"
            ? "Web"
            : perpsRuntimePlatform === "pwa"
              ? "PWA"
              : "Web";
  const perpsProviderLabel =
    jupiterPerpsController?.connected
      ? (nativeMacShell ? "WalletConnect" : "Jupiter Mobile")
      : perpsAgentSession?.walletProvider
        ?? (remoteAuthSource === "phantom" ? "Phantom" : wallet.connected ? "In-app wallet" : "Disconnected");
  const activeWalletProviderLabel =
    nativeWalletShell && jupiterPerpsController?.connected
      ? "WalletConnect"
      : wallet.connected
        ? "In-app wallet"
        : "Disconnected";
  const activeWalletAddress =
    (nativeWalletShell ? jupiterPerpsController?.walletAddress : null) ?? wallet.publicKey?.toBase58() ?? null;
  const perpsLogWalletAddress =
    jupiterPerpsController?.walletAddress
    ?? wallet.publicKey?.toBase58()
    ?? remoteSyncWalletAddress
    ?? perpsAgentSession?.walletAddress
    ?? null;
  const portfolioWalletAddress = activeWalletAddress;
  const clearRemoteAuthDisconnectTimeout = useCallback(() => {
    if (remoteAuthDisconnectTimeoutRef.current) {
      clearTimeout(remoteAuthDisconnectTimeoutRef.current);
      remoteAuthDisconnectTimeoutRef.current = null;
    }
  }, []);
  const navigateToNotificationUrl = useCallback((url: string) => {
    if (typeof window === "undefined" || !url) return;
    if (/^https?:\/\//i.test(url)) {
      window.location.assign(url);
      return;
    }
    router.push(url.startsWith("/") ? url : `/${url}`);
  }, [router]);
  const perpsWalletControlNote = perpsModeLabel === "Live mode"
    ? perpsLiveWalletAllowed
      ? "Live automation uses only your own connected wallet session. BremLogic does not use a shared backend trading wallet."
      : "Live Perps automation is restricted to approved wallets only. This wallet can still use paper mode, spot auto-trade, and manual Perps."
    : "Paper automation simulates Perps decisions for your connected wallet session without moving funds.";
  const manualSwapPassthroughWalletContextState = useMemo<Record<string, unknown>>(() => {
    if (nativeWalletShell && jupiterPerpsController?.connected && jupiterPerpsController.walletAddress) {
      const publicKey = new PublicKey(jupiterPerpsController.walletAddress);
      const adapter = {
        name: "WalletConnect",
        url: "https://jup.ag",
        icon: "",
        publicKey,
        connecting: false,
        connected: true,
        disconnect: async () => undefined,
        connect: async () => {
          await jupiterPerpsController.connect();
        },
        sendTransaction: async (transaction: unknown, conn: typeof connection, options?: { skipPreflight?: boolean; maxRetries?: number }) => {
          if (!(transaction instanceof VersionedTransaction)) {
            throw new Error("Unsupported transaction format");
          }
          const signed = await jupiterPerpsController.signTransaction(transaction);
          return conn.sendRawTransaction(signed.serialize(), {
            skipPreflight: options?.skipPreflight ?? false,
            maxRetries: options?.maxRetries ?? 3,
          });
        },
        signTransaction: async (transaction: unknown) => {
          if (!(transaction instanceof VersionedTransaction)) {
            throw new Error("Unsupported transaction format");
          }
          return jupiterPerpsController.signTransaction(transaction);
        },
        signAllTransactions: async (transactions: unknown[]) => {
          const signed: VersionedTransaction[] = [];
          for (const transaction of transactions) {
            if (!(transaction instanceof VersionedTransaction)) {
              throw new Error("Unsupported transaction format");
            }
            signed.push(await jupiterPerpsController.signTransaction(transaction));
          }
          return signed;
        },
        signMessage: undefined,
      };

      const walletContext = {
        publicKey,
        wallets: [{ adapter, readyState: "Installed" }],
        wallet: { adapter, readyState: "Installed" },
        connect: async () => {
          await jupiterPerpsController.connect();
        },
        select: () => undefined,
        connecting: false,
        connected: true,
        disconnect: async () => undefined,
        autoConnect: false,
        disconnecting: false,
        sendTransaction: adapter.sendTransaction,
        signTransaction: adapter.signTransaction,
        signAllTransactions: adapter.signAllTransactions,
        signMessage: undefined,
        signIn: undefined,
      };

      return walletContext;
    }

    return wallet.passthroughWalletContextState;
  }, [jupiterPerpsController, nativeWalletShell, wallet.passthroughWalletContextState]);

  useEffect(() => {
    setRenderNow(Date.now());
    setNativeShell(isNativeShellApp());
    setNativeMacShell(isNativeMacRuntime());
    setStandalonePwa(isStandalonePwaRuntime());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPositionOverlayEnabled(window.localStorage.getItem(POSITION_OVERLAY_STORAGE_KEY) !== "false");
    setScalpOverlayEnabled(window.localStorage.getItem(SCALP_OVERLAY_STORAGE_KEY) === "true");
  }, []);

  useEffect(() => {
    const syncActiveTab = () => {
      if (typeof window === "undefined") return;
      const tab = new URLSearchParams(window.location.search).get("tab");
      if (tab === "signals" || tab === "perps" || tab === "simulator" || tab === "wallet") {
        setActiveSignalsTab(tab);
        return;
      }
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("tab", "signals");
      window.history.replaceState({}, "", nextUrl.toString());
      setActiveSignalsTab("signals");
    };

    const syncActiveTabAtTop = () => {
      syncActiveTab();
      window.requestAnimationFrame(() => {
        scrollAppToTop();
      });
    };

    syncActiveTab();
    window.addEventListener("popstate", syncActiveTabAtTop);
    window.addEventListener(SIGNALS_BOT_TAB_EVENT, syncActiveTabAtTop);
    return () => {
      window.removeEventListener("popstate", syncActiveTabAtTop);
      window.removeEventListener(SIGNALS_BOT_TAB_EVENT, syncActiveTabAtTop);
    };
  }, [router]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncAiPanelFromUrl = () => {
      const url = new URL(window.location.href);
      const open = url.searchParams.get("ai") === "open";
      setAiPanelOpen(open);
      window.dispatchEvent(new CustomEvent(AI_PANEL_STATE_EVENT, { detail: { open } }));
    };

    const toggleAiPanel = () => {
      setAiPanelOpen((current) => {
        const next = !current;
        const url = new URL(window.location.href);
        if (next) {
          url.searchParams.set("ai", "open");
        } else {
          url.searchParams.delete("ai");
        }
        window.history.replaceState({}, "", url.toString());
        window.dispatchEvent(new CustomEvent(AI_PANEL_STATE_EVENT, { detail: { open: next } }));
        return next;
      });
    };

    syncAiPanelFromUrl();
    window.addEventListener("popstate", syncAiPanelFromUrl);
    window.addEventListener(AI_PANEL_TOGGLE_EVENT, toggleAiPanel);
    return () => {
      window.removeEventListener("popstate", syncAiPanelFromUrl);
      window.removeEventListener(AI_PANEL_TOGGLE_EVENT, toggleAiPanel);
    };
  }, []);

  const clearPerpsAutoTradeTimeout = useCallback(() => {
    if (perpsAutoTradeTimeoutRef.current) {
      clearTimeout(perpsAutoTradeTimeoutRef.current);
      perpsAutoTradeTimeoutRef.current = null;
    }
  }, []);

  const clearPerpsAutoTradeErrorResetTimeout = useCallback(() => {
    if (perpsAutoTradeErrorResetTimeoutRef.current) {
      clearTimeout(perpsAutoTradeErrorResetTimeoutRef.current);
      perpsAutoTradeErrorResetTimeoutRef.current = null;
    }
  }, []);

  const clearPerpsAutoTradeFailureCooldown = useCallback(() => {
    perpsAutoTradeFailureCooldownUntilRef.current = 0;
    clearPerpsAutoTradeErrorResetTimeout();
  }, [clearPerpsAutoTradeErrorResetTimeout]);

  const isPerpsAutoTradeFailureCooldownActive = useCallback(() => {
    return perpsAutoTradeFailureCooldownUntilRef.current > Date.now();
  }, []);

  const clearActiveApprovalTimeout = useCallback(() => {
    if (activeApprovalTimeoutRef.current) {
      clearTimeout(activeApprovalTimeoutRef.current);
      activeApprovalTimeoutRef.current = null;
    }
  }, []);

  const clearActiveApprovalState = useCallback(() => {
    clearActiveApprovalTimeout();
    approvalConnectStartedRef.current = null;
    approvalExecutionStartedRef.current = null;
    setActiveApprovalId(null);
    setActiveApprovalStatus(null);
    if (typeof window !== "undefined") {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("approval");
      window.history.replaceState({}, "", nextUrl.toString());
    }
  }, [clearActiveApprovalTimeout]);

  const getPerpsAutoTradeReadyStatus = useCallback((
    tokenSymbol: string,
    options?: {
      activePositionLabel?: string | null;
      unsupported?: boolean;
      waitingForWallet?: boolean;
    }
  ) => {
    const perpsModeLabel =
      autoTradeSettings.perpsExecutionMode === "smart-trades"
        ? `smart ${autoTradeSettings.smartTradeProfile}`
        : "set params";

    if (options?.unsupported) {
      return `Perps auto-trade only supports SOL, ETH, or BTC. ${tokenSymbol} is not supported.`;
    }

    if (options?.waitingForWallet) {
      return `Perps auto-trade is armed for ${tokenSymbol}, waiting for Jupiter Mobile`;
    }

    if (options?.activePositionLabel) {
      return `Perps auto-trade is on (${tokenSymbol}, ${formatAutoTradeAllocationLabel(autoTradeSettings, "collateral")}, ${autoTradeSettings.perpsLeverage}x, ${perpsModeLabel}) · ${options.activePositionLabel}`;
    }

    return `Perps auto-trade is on (${tokenSymbol}, ${formatAutoTradeAllocationLabel(autoTradeSettings, "collateral")}, ${autoTradeSettings.perpsLeverage}x, ${autoTradeSettings.mode === "buy-only" ? "Buy Only" : "All"}, ${perpsModeLabel})`;
  }, [autoTradeSettings]);

  const setPerpsAutoTradeFailureCooldown = useCallback((tokenSymbol: string, message: string) => {
    clearPerpsAutoTradeErrorResetTimeout();
    perpsAutoTradeFailureCooldownUntilRef.current = Date.now() + AUTO_TRADE_ERROR_AUTO_RESET_MS;
    setPerpsAutoTradeStatus(
      `Perps auto-trade failed for ${tokenSymbol}: ${message} Cooling down for ${Math.round(AUTO_TRADE_ERROR_AUTO_RESET_MS / 1000)}s.`
    );
    perpsAutoTradeErrorResetTimeoutRef.current = setTimeout(() => {
      perpsAutoTradeFailureCooldownUntilRef.current = 0;
      if (!perpsAutoTradeBusyRef.current) {
        setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(tokenSymbol));
      }
      perpsAutoTradeErrorResetTimeoutRef.current = null;
    }, AUTO_TRADE_ERROR_AUTO_RESET_MS);
  }, [clearPerpsAutoTradeErrorResetTimeout, getPerpsAutoTradeReadyStatus]);

  const sendSignalNotification = useCallback(async (
    title: string,
    body: string,
    url?: string,
    sound: NativeNotificationSound = NATIVE_NOTIFICATION_SOUNDS.signal,
  ) => {
    if (!pushEnabled) return;

    if (nativeShell) {
      try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2147483000,
              title,
              body,
              sound,
              extra: url ? { url } : undefined,
            },
          ],
        });
      } catch {
        // ignore native notification delivery failures
      }
      return;
    }

    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  }, [nativeShell, pushEnabled]);

  const sendRemotePushNotification = useCallback(async (payload: {
    title: string;
    body: string;
    url: string;
    walletAddress?: string | null;
    sound?: NativeNotificationSound;
  }) => {
    if (!pushEnabled) return;

    await fetch("/api/push/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        subscription,
        nativeToken: nativePushToken,
      }),
    }).catch(() => undefined);
  }, [nativePushToken, pushEnabled, subscription]);

  const refreshPerpsAgentState = useCallback(async () => {
    if (!remoteAuthToken) {
      const localSession = loadLocalPerpsAgentSession();
      const localExecutions = loadLocalPerpsAgentExecutions();
      setPerpsAgentSession(localSession);
      setPerpsAgentExecutions(localExecutions);
      setDecisionLogEntries(loadLocalDecisionLogEntries(
        localSession?.walletAddress
        ?? jupiterPerpsController?.walletAddress
        ?? walletAddress
        ?? remoteSyncWalletAddress
        ?? null
      ));
      if (localSession?.mode) {
        setPerpsSessionModePreference(localSession.mode);
        setPerpsUnlimitedSession(localSession.unlimitedSession);
      }
      return {
        session: localSession,
        executions: localExecutions,
      };
    }

    const [sessionResponse, executionsResponse] = await Promise.all([
      fetch("/api/perps/session/status", {
        cache: "no-store",
        headers: { Authorization: `Bearer ${remoteAuthToken}` },
      }),
      fetch("/api/perps/executions?limit=50", {
        cache: "no-store",
        headers: { Authorization: `Bearer ${remoteAuthToken}` },
      }),
    ]);

    const sessionPayload = await sessionResponse.json().catch(() => null) as
      | { session?: PerpsSessionSnapshot | null; error?: string }
      | null;
    const executionPayload = await executionsResponse.json().catch(() => null) as
      | { executions?: PerpsExecutionSummary[]; error?: string }
      | null;

    if (sessionResponse.ok && sessionPayload && "session" in sessionPayload) {
      setPerpsAgentSession(sessionPayload.session ?? null);
      if (sessionPayload.session?.mode) {
        setPerpsSessionModePreference(sessionPayload.session.mode);
        setPerpsUnlimitedSession(sessionPayload.session.unlimitedSession);
      }
    }

    if (executionsResponse.ok && executionPayload && Array.isArray(executionPayload.executions)) {
      setPerpsAgentExecutions(executionPayload.executions);
    }

    return {
      session: sessionResponse.ok ? sessionPayload?.session ?? null : null,
      executions: executionsResponse.ok ? executionPayload?.executions ?? [] : [],
    };
  }, [jupiterPerpsController?.walletAddress, remoteAuthToken, remoteSyncWalletAddress, walletAddress]);

  const refreshPerpsExecutionFeed = useCallback(async () => {
    if (!remoteAuthToken) return;
    const response = await fetch("/api/perps/executions?limit=50", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${remoteAuthToken}` },
    });
    const payload = await response.json().catch(() => null) as { executions?: PerpsExecutionSummary[] } | null;
    if (response.ok && Array.isArray(payload?.executions)) setPerpsAgentExecutions(payload.executions);
  }, [remoteAuthToken]);

  const clearPerpsAgentExecutions = useCallback(async () => {
    if (!remoteAuthToken) {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY);
        window.sessionStorage.removeItem(PERPS_AGENT_LOCAL_EXECUTIONS_STORAGE_KEY);
      }
      setPerpsAgentExecutions([]);
      return;
    }

    const response = await fetch("/api/perps/executions", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${remoteAuthToken}` },
    });
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(payload?.error ?? "Unable to clear recent agent executions.");
    }
    setPerpsAgentExecutions([]);
  }, [remoteAuthToken]);

  const submitPerpsAgentSignal = useCallback(async (input: {
    signal: Signal;
    request: PendingPerpsApprovalRequest;
    collateralUsd: number;
    marketContext?: {
      spotPrice?: number | null;
      volatilityPercent?: number | null;
      trendBias?: "bullish" | "bearish" | "sideways" | null;
      availableUsdc?: number | null;
      hasOpenPosition?: boolean;
      recentPriceChangePercent?: number | null;
    };
  }) => {
    if (!remoteAuthToken) {
      const localSession = loadLocalPerpsAgentSession();
      const localLearningProfile = loadLocalLearningProfile(
        localSession?.walletAddress
        ?? jupiterPerpsController?.walletAddress
        ?? walletAddress
        ?? remoteSyncWalletAddress
        ?? null
      );
      if (perpsSessionModePreference === "live" && !perpsLiveWalletAllowed) {
        throw new Error("Live Perps automation is not enabled for this wallet.");
      }
      const requestedLeverage = Number(input.request.leverage);
      const signalConfidence = clampNumber(input.signal.confidence ?? 0.72, 0, 1);
      const directionBonus =
        !localLearningProfile || localLearningProfile.preferredDirection === "balanced"
          ? 0
          : localLearningProfile.preferredDirection === input.signal.direction
            ? 0.05
            : -0.08;
      const leveragePenalty =
        localLearningProfile && requestedLeverage > localLearningProfile.leverageCap
          ? -0.12
          : 0;
      const learnedConfidence = clampNumber(signalConfidence + directionBonus + leveragePenalty, 0, 1);
      const confidenceFloor = localLearningProfile?.minimumConfidence ?? 0.58;
      const shouldTrade = learnedConfidence >= confidenceFloor;
      const adjustedLeverage = localLearningProfile
        ? Math.min(requestedLeverage, localLearningProfile.leverageCap)
        : requestedLeverage;
      const adjustedCollateralUsd = localLearningProfile
        ? Number((input.collateralUsd * localLearningProfile.sizeMultiplier).toFixed(2))
        : input.collateralUsd;
      const localExecution: PerpsExecutionSummary = {
        executionId: `local-exec-${input.signal.id}-${Date.now()}`,
        signalId: input.signal.id,
        symbol: input.signal.symbol,
        summary: input.signal.summary,
        market: `${input.request.asset}-PERP`,
        side: input.request.side,
        action: "open",
        sizeUsd: Number((adjustedCollateralUsd * adjustedLeverage).toFixed(2)),
        leverage: adjustedLeverage,
        status: shouldTrade ? (perpsSessionModePreference === "paper" ? "paper_executed" : "approval_required") : "blocked",
        mode: perpsSessionModePreference,
        executionModel: "approval-assisted",
        reasonCode: shouldTrade ? "LOCAL_SESSION" : "LOCAL_TRAINING_SKIP",
        reasonMessage: shouldTrade
          ? (
              perpsSessionModePreference === "paper"
                ? "Paper execution recorded for the active local wallet session."
                : "Approval-assisted live execution prepared for the active local wallet session."
            )
          : `Local training profile skipped this setup because the learned confidence floor is ${Math.round(confidenceFloor * 100)}% and the adjusted score was ${Math.round(learnedConfidence * 100)}%.`,
        decisionConfidence: learnedConfidence,
        decisionShouldTrade: shouldTrade,
        decisionSummary: shouldTrade
          ? (
              localLearningProfile
                ? `Local learning profile accepted this trade with a ${Math.round(learnedConfidence * 100)}% adjusted confidence score.`
                : "Local fallback routing accepted this trade."
            )
          : `Local learning profile rejected this trade after applying wallet-specific confidence and leverage constraints.`,
        decisionTags: [
          "local-decision-log",
          localLearningProfile ? "wallet-trained-profile" : "default-local-profile",
          input.signal.direction === "bullish" ? "long-bias" : "short-bias",
        ],
        decisionShadowMode: false,
        createdAt: new Date().toISOString(),
        txid: null,
      };
      const localDecisionEntry: DecisionLogEntry = {
        payload: {
          decisionId: `local-decision-${input.signal.id}-${Date.now()}`,
          createdAt: localExecution.createdAt,
          walletAddress: localSession?.walletAddress ?? jupiterPerpsController?.walletAddress ?? walletAddress ?? remoteSyncWalletAddress ?? "local-session",
          sessionId: localSession?.sessionId ?? "local-session",
          sessionMode: perpsSessionModePreference,
          executionModel: "approval-assisted",
          signalId: input.signal.id,
          symbol: input.signal.symbol,
          summary: input.signal.summary,
          direction: input.signal.direction,
          signalConfidence: input.signal.confidence,
          asset: input.request.asset,
          requestedTrade: {
            collateralUsd: adjustedCollateralUsd,
            leverage: adjustedLeverage,
            takeProfitPrice: input.request.takeProfitPrice ?? null,
            stopLossPrice: input.request.stopLossPrice ?? null,
            maxSlippageBps: Number(input.request.maxSlippageBps ?? "100"),
            executionStyle: autoTradeSettings.perpsExecutionMode,
            smartTradeProfile: autoTradeSettings.smartTradeProfile,
          },
          marketContext: {
            spotPrice: input.marketContext?.spotPrice ?? null,
            volatilityPercent: input.marketContext?.volatilityPercent ?? null,
            trendBias: input.marketContext?.trendBias ?? null,
            availableUsdc: input.marketContext?.availableUsdc ?? null,
            hasOpenPosition: input.marketContext?.hasOpenPosition ?? false,
            recentPriceChangePercent: input.marketContext?.recentPriceChangePercent ?? null,
          },
        },
        recommendation: {
          shouldTrade,
          confidenceScore: learnedConfidence,
          riskGrade:
            adjustedLeverage >= 6
              ? "high"
              : adjustedLeverage >= 3
                ? "medium"
                : "low",
          sizeMultiplier: localLearningProfile?.sizeMultiplier ?? 1,
          leverageMultiplier: requestedLeverage > 0 ? adjustedLeverage / requestedLeverage : 1,
          recommendedCollateralUsd: adjustedCollateralUsd,
          recommendedLeverage: adjustedLeverage,
          recommendedTakeProfitPrice: input.request.takeProfitPrice ?? null,
          recommendedStopLossPrice: input.request.stopLossPrice ?? null,
          explanationTags: [
            perpsSessionModePreference === "paper" ? "paper-mode" : "live-approval",
            input.signal.direction === "bullish" ? "long-bias" : "short-bias",
            autoTradeSettings.perpsExecutionMode,
            autoTradeSettings.smartTradeProfile,
            localLearningProfile ? "trained-agent" : "untrained-agent",
          ],
          explanationSummary: shouldTrade
            ? (
                perpsSessionModePreference === "paper"
                  ? `Local paper session accepted this ${input.signal.direction === "bullish" ? "long" : "short"} setup${localLearningProfile ? " after applying the trained wallet profile" : ""} and recorded a simulated Perps execution.`
                  : `Local live session accepted this ${input.signal.direction === "bullish" ? "long" : "short"} setup${localLearningProfile ? " after applying the trained wallet profile" : ""} and prepared it for approval-assisted execution.`
              )
            : `The trained local agent profile skipped this setup because the adjusted score stayed below the wallet-specific confidence floor.`,
          shadowMode: false,
        },
      };
      const nextExecutions = [localExecution, ...loadLocalPerpsAgentExecutions()].slice(0, 20);
      const walletLogAddress =
        localDecisionEntry.payload.walletAddress
        ?? localSession?.walletAddress
        ?? jupiterPerpsController?.walletAddress
        ?? walletAddress
        ?? remoteSyncWalletAddress
        ?? null;
      const nextDecisionEntries = [localDecisionEntry, ...loadLocalDecisionLogEntries(walletLogAddress)].slice(0, 40);
      saveLocalPerpsAgentExecutions(nextExecutions);
      saveLocalDecisionLogEntries(walletLogAddress, nextDecisionEntries);
      setPerpsAgentExecutions(nextExecutions);
      setDecisionLogEntries(nextDecisionEntries);
      return {
        ok: shouldTrade,
        message: localExecution.reasonMessage,
        preparedAction: input.request,
        execution: localExecution,
      };
    }

    const response = await fetch("/api/perps/agent/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${remoteAuthToken}`,
      },
      body: JSON.stringify({
        signalId: input.signal.id,
        symbol: input.signal.symbol,
        summary: input.signal.summary,
        direction: input.signal.direction,
        signalConfidence: input.signal.confidence,
        asset: input.request.asset,
        collateralUsd: input.collateralUsd,
        leverage: Number(input.request.leverage),
        maxSlippageBps: Number(input.request.maxSlippageBps ?? "100"),
        takeProfitPrice: input.request.takeProfitPrice ?? null,
        stopLossPrice: input.request.stopLossPrice ?? null,
        smartTradeProfile: autoTradeSettings.smartTradeProfile,
        executionStyle: autoTradeSettings.perpsExecutionMode,
        marketContext: input.marketContext ?? undefined,
      }),
    });

    const payload = await response.json().catch(() => null) as
      | {
          ok: boolean;
          message?: string;
          preparedAction?: PendingPerpsApprovalRequest;
          execution?: PerpsExecutionSummary & { mode: "paper" | "live" };
        }
      | { error?: string; message?: string; code?: string; execution?: PerpsExecutionSummary }
      | null;

    if (!response.ok || !payload || ("error" in payload && payload.error)) {
      const detail = (payload && "message" in payload ? payload.message : null) || (payload && "error" in payload ? payload.error : null);
      const statusLabel = response.status ? `HTTP ${response.status}` : "request failed";
      throw new Error(detail ? `${statusLabel}: ${detail}` : `Unable to execute the perps signal. ${statusLabel}.`);
    }

    await refreshPerpsAgentState().catch(() => undefined);
    return payload;
  }, [autoTradeSettings.perpsExecutionMode, autoTradeSettings.smartTradeProfile, jupiterPerpsController?.walletAddress, perpsLiveWalletAllowed, perpsSessionModePreference, refreshPerpsAgentState, remoteAuthToken, remoteSyncWalletAddress, walletAddress]);

  const openDecisionLog = useCallback(async () => {
    setDecisionLogOpen(true);
    setDecisionLogBusy(true);
    setDecisionLogContent("Loading decision log...");

    try {
      if (!remoteAuthToken) {
        const localEntries = loadLocalDecisionLogEntries(perpsLogWalletAddress);
        setDecisionLogExecutionHistory(loadLocalPerpsAgentExecutions());
        setDecisionLogEntries(localEntries);
        setDecisionLogContent(localEntries.length > 0 ? "Local Perps agent decision log loaded." : "No decision log entries yet.");
        return;
      }

      const response = await fetch("/api/perps/decision-log?limit=100", {
        cache: "no-store",
        headers: { Authorization: `Bearer ${remoteAuthToken}` },
      });
      const payload = await response.json().catch(() => null) as {
        content?: string;
        entries?: DecisionLogEntry[];
        executions?: PerpsExecutionSummary[];
      } | null;
      if (!response.ok) {
        throw new Error("Unable to load the decision log.");
      }
      setDecisionLogContent(payload?.content?.trim() || "No decision log entries yet.");
      setDecisionLogEntries(Array.isArray(payload?.entries) ? payload!.entries : []);
      setDecisionLogExecutionHistory(Array.isArray(payload?.executions) ? payload!.executions : []);
    } catch (error) {
      setDecisionLogContent(error instanceof Error ? error.message : "Unable to load the decision log.");
      setDecisionLogEntries([]);
      setDecisionLogExecutionHistory([]);
    } finally {
      setDecisionLogBusy(false);
    }
  }, [perpsLogWalletAddress, remoteAuthToken]);

  const trainDecisionAgent = useCallback(async () => {
    if (!perpsLogWalletAddress) {
      setDecisionLearningStatus("Connect a wallet first so the training profile can be saved to that wallet.");
      return;
    }

    if (remoteAuthToken) {
      setDecisionLearningBusy(true);
      setDecisionLearningStatus("Reconciling closed Jupiter trades and validating a wallet-specific training profile...");
      try {
        const response = await fetch("/api/perps/training", {
          method: "POST",
          headers: { Authorization: `Bearer ${remoteAuthToken}` },
        });
        const payload = await response.json().catch(() => null) as {
          error?: string;
          activated?: boolean;
          skipped?: boolean;
          outcomeCount?: number;
          reconciledOutcomes?: number;
          profile?: {
            version: number;
            source: string;
            summary: string;
            validation: { passed: boolean; reasons: string[] };
          };
        } | null;
        if (!response.ok || !payload?.profile) {
          throw new Error(payload?.error ?? "Unable to train the server-side agent profile.");
        }
        const state = payload.activated
          ? "activated"
          : payload.profile.validation.passed
            ? "already current"
            : "saved as a candidate; the prior active profile remains in control";
        setDecisionLearningStatus(
          `Agent profile v${payload.profile.version} ${state}. ${payload.profile.summary} `
          + `Closed outcomes: ${payload.outcomeCount ?? 0}; newly reconciled: ${payload.reconciledOutcomes ?? 0}.`
        );
        return;
      } catch (error) {
        setDecisionLearningStatus(error instanceof Error ? error.message : "Unable to train the server-side agent profile.");
        return;
      } finally {
        setDecisionLearningBusy(false);
      }
    }

    const entries = loadLocalDecisionLogEntries(perpsLogWalletAddress);

    if (entries.length === 0) {
      setDecisionLearningStatus("No decision log entries are available yet for this wallet.");
      return;
    }

    setDecisionLearningBusy(true);
    try {
      const confidenceAverage = entries.reduce((sum, entry) => sum + entry.recommendation.confidenceScore, 0) / entries.length;
      const averageLeverage = entries.reduce((sum, entry) => sum + entry.payload.requestedTrade.leverage, 0) / entries.length;
      const bullishCount = entries.filter((entry) => entry.payload.direction === "bullish").length;
      const bearishCount = entries.length - bullishCount;
      const blockedCount = entries.filter((entry) => !entry.recommendation.shouldTrade).length;
      const preferredDirection =
        Math.abs(bullishCount - bearishCount) <= 1
          ? "balanced"
          : bullishCount > bearishCount
            ? "bullish"
            : "bearish";

      const profile: DecisionLearningProfile = {
        walletAddress: perpsLogWalletAddress,
        learnedAt: new Date().toISOString(),
        minimumConfidence: clampNumber(confidenceAverage + (blockedCount / Math.max(entries.length, 1)) * 0.04, 0.45, 0.82),
        leverageCap: clampNumber(averageLeverage + 0.25, 1, 8),
        preferredDirection,
        sizeMultiplier: clampNumber(blockedCount / Math.max(entries.length, 1) > 0.35 ? 0.88 : 1, 0.7, 1),
        summary:
          `Learned from ${entries.length} decision entries. Confidence floor ${Math.round(clampNumber(confidenceAverage + (blockedCount / Math.max(entries.length, 1)) * 0.04, 0.45, 0.82) * 100)}%, leverage cap ${clampNumber(averageLeverage + 0.25, 1, 8).toFixed(2)}x, direction bias ${preferredDirection}.`,
        learnedFromEntries: entries.length,
      };

      saveLocalLearningProfile(profile);
      setDecisionLearningStatus(`Agent training updated for ${shortAddress(perpsLogWalletAddress)}. ${profile.summary}`);
    } finally {
      setDecisionLearningBusy(false);
    }
  }, [perpsLogWalletAddress, remoteAuthToken]);

  const currentAiMarket = useMemo(() => {
    const selectedMarket = trackedMarkets.find((market) => market.id === selectedChartSlotId) ?? trackedMarkets[0] ?? null;
    const points = priceHistory[selectedMarket?.id ?? ""] ?? [];
    const recentCandles = points.slice(-48).map((point) => ({ t: point.t, v: point.v }));
    const latestSignal = signals.find((signal) => signal.symbol === selectedMarket?.pair) ?? signals[0] ?? null;
    const latestPerpsExecution = perpsAgentExecutions[0] ?? null;

    return {
      symbol: selectedMarket?.pair ?? "Unknown market",
      timeframe: `${params.trendWindow}m trend / current dashboard`,
      currentPrice: points[points.length - 1]?.v ?? null,
      recentCandles,
      latestSignal: latestSignal
        ? {
            direction: latestSignal.direction,
            confidence: latestSignal.confidence,
            summary: latestSignal.summary,
          }
        : null,
      activePerpsTrade: latestPerpsExecution
        ? {
            side: latestPerpsExecution.side,
            entryPrice: null,
            takeProfitPrice: null,
            stopLossPrice: null,
          }
        : null,
    };
  }, [params.trendWindow, perpsAgentExecutions, priceHistory, selectedChartSlotId, signals, trackedMarkets]);

  const runAiAnalysis = useCallback(async (prompt: string) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;

    const nextUserMessage: AiChatMessage = {
      role: "user",
      content: trimmedPrompt,
    };

    const nextHistory = [...aiChatMessages, nextUserMessage];
    setAiChatMessages(nextHistory);
    setAiPrompt("");
    setAiBusy(true);
    setAiStatus("AI is analyzing the current market context...");

    try {
      const response = await fetch("/api/ai/market-explainer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          symbol: currentAiMarket.symbol,
          timeframe: currentAiMarket.timeframe,
          currentPrice: currentAiMarket.currentPrice,
          recentCandles: currentAiMarket.recentCandles,
          latestSignal: currentAiMarket.latestSignal,
          activePerpsTrade: currentAiMarket.activePerpsTrade,
          chatHistory: aiChatMessages.slice(-6),
        }),
      });
      const payload = await response.json().catch(() => null) as { answer?: string; error?: string; detail?: string } | null;
      if (!response.ok || !payload?.answer) {
        throw new Error(payload?.error ?? payload?.detail ?? "AI analysis is unavailable right now.");
      }

      setAiChatMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: payload.answer!,
        },
      ]);
      setAiStatus("AI analysis ready.");
    } catch (error) {
      setAiChatMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: error instanceof Error ? error.message : "AI analysis failed.",
        },
      ]);
      setAiStatus("AI analysis failed.");
    } finally {
      setAiBusy(false);
    }
  }, [aiChatMessages, currentAiMarket]);

  const legacyDecisionExecutions = useMemo(() => (
    decisionLogExecutionHistory.filter((execution) => !execution.decisionSummary)
  ), [decisionLogExecutionHistory]);

  const decisionExecutionsById = useMemo(() => {
    const byDecisionId = new Map<string, PerpsExecutionSummary>();
    decisionLogExecutionHistory.forEach((execution) => {
      if (execution.decisionId && !byDecisionId.has(execution.decisionId)) {
        byDecisionId.set(execution.decisionId, execution);
      }
    });
    return byDecisionId;
  }, [decisionLogExecutionHistory]);

  const setAiPanelVisibility = useCallback((open: boolean) => {
    setAiPanelOpen(open);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (open) {
      url.searchParams.set("ai", "open");
    } else {
      url.searchParams.delete("ai");
    }
    window.history.replaceState({}, "", url.toString());
    window.dispatchEvent(new CustomEvent(AI_PANEL_STATE_EVENT, { detail: { open } }));
  }, []);

  const submitAiPrompt = useCallback(async () => {
    if (aiBusy) return;
    await runAiAnalysis(aiPrompt);
  }, [aiBusy, aiPrompt, runAiAnalysis]);

  const clockInPerpsAgent = useCallback(async () => {
    setPerpsSessionBusy(true);
    try {
      const platform = nativeWalletShell
        ? "native"
        : (typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches ? "pwa" : "web");
      const walletProvider =
        jupiterPerpsController?.connected
          ? (nativeMacShell ? "WalletConnect" : "Jupiter Mobile")
          : remoteAuthSource === "phantom"
            ? "Phantom"
            : wallet.connected
              ? "In-app wallet"
              : "Disconnected";

      if (!remoteAuthToken) {
        if (perpsSessionModePreference === "live" && !perpsLiveWalletAllowed) {
          throw new Error("Live Perps automation is not enabled for this wallet.");
        }
        const localSession: PerpsSessionSnapshot = {
          sessionId: `local-${Date.now()}`,
          walletAddress: jupiterPerpsController?.walletAddress ?? walletAddress ?? remoteSyncWalletAddress ?? "local-session",
          sessionState: "clocked_in",
          startedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          endedAt: null,
          mode: perpsSessionModePreference,
          executionModel: perpsSessionModePreference === "live" ? "approval-assisted" : "approval-assisted",
          appOpen: true,
          appForeground: true,
          walletConnected: perpsWalletConnected,
          walletWriteEnabled: Boolean(jupiterPerpsController?.canWrite),
          killSwitch: false,
          unlimitedSession: perpsUnlimitedSession,
          platform,
          walletProvider,
          warning: perpsUnlimitedSession
            ? "Unlimited session is enabled for this device session. Guardrails still remain active."
            : (perpsSessionModePreference === "live" && !jupiterPerpsController?.canWrite
                ? "Live mode needs an active writable Jupiter wallet session. Paper mode can still clock in."
                : "Running in local session mode because remote auth is not available for this wallet path."),
        };
        saveLocalPerpsAgentSession(localSession);
        setPerpsAgentSession(localSession);
        setPerpsAutoTradeStatus(
          `${localSession.mode === "paper" ? "Paper mode" : "Live mode"} · Clocked In · ${localSession.executionModel}`
        );
        await refreshPerpsAgentState().catch(() => undefined);
        return;
      }

      const response = await fetch("/api/perps/session/clock-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${remoteAuthToken}`,
        },
        body: JSON.stringify({
          mode: perpsSessionModePreference,
          unlimitedSession: perpsUnlimitedSession,
          appOpen: true,
          platform,
          walletProvider,
        }),
      });
      const payload = await response.json().catch(() => null) as { session?: PerpsSessionSnapshot; error?: string } | null;
      if (!response.ok || !payload?.session) {
        throw new Error(payload?.error ?? "Unable to clock in the Perps agent.");
      }
      setPerpsAgentSession(payload.session);
      setPerpsAutoTradeStatus(
        `${payload.session.mode === "paper" ? "Paper mode" : "Live mode"} · Clocked In · ${payload.session.executionModel}`
      );
      await refreshPerpsAgentState().catch(() => undefined);
    } finally {
      setPerpsSessionBusy(false);
    }
  }, [jupiterPerpsController?.canWrite, jupiterPerpsController?.connected, jupiterPerpsController?.walletAddress, nativeMacShell, nativeWalletShell, perpsLiveWalletAllowed, perpsSessionModePreference, perpsUnlimitedSession, perpsWalletConnected, refreshPerpsAgentState, remoteAuthSource, remoteAuthToken, remoteSyncWalletAddress, wallet.connected, walletAddress]);

  const clockOutPerpsAgent = useCallback(async (reason?: string) => {
    setPerpsSessionBusy(true);
    try {
      if (!remoteAuthToken) {
        saveLocalPerpsAgentSession(null);
        setPerpsAgentSession((current) => current ? { ...current, sessionState: "clocked_out", endedAt: new Date().toISOString() } : null);
        setPerpsAutoTradeStatus("Perps auto-trade is off");
        await refreshPerpsAgentState().catch(() => undefined);
        return;
      }

      await fetch("/api/perps/session/clock-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${remoteAuthToken}`,
        },
        body: JSON.stringify({ reason }),
      }).catch(() => undefined);
      setPerpsAgentSession((current) => current ? { ...current, sessionState: "clocked_out", endedAt: new Date().toISOString() } : current);
      setPerpsAutoTradeStatus("Perps auto-trade is off");
      await refreshPerpsAgentState().catch(() => undefined);
    } finally {
      setPerpsSessionBusy(false);
    }
  }, [refreshPerpsAgentState, remoteAuthToken]);

  const sendPerpsSessionHeartbeat = useCallback(async (input: {
    appOpen: boolean;
    appForeground: boolean;
    walletConnected: boolean;
    walletWriteEnabled: boolean;
    reason?: string;
  }) => {
    if (!remoteAuthToken || !perpsAgentSession || perpsAgentSession.sessionState !== "clocked_in") {
      if (!remoteAuthToken && perpsAgentSession?.sessionState === "clocked_in") {
        const nextSession: PerpsSessionSnapshot = {
          ...perpsAgentSession,
          appOpen: input.appOpen,
          appForeground: input.appForeground,
          walletConnected: input.walletConnected,
          walletWriteEnabled: input.walletWriteEnabled,
          lastHeartbeatAt: new Date().toISOString(),
        };
        if (!input.appOpen || !input.appForeground || !input.walletConnected) {
          nextSession.inactiveSince = nextSession.inactiveSince ?? new Date().toISOString();
        } else {
          nextSession.inactiveSince = null;
        }
        saveLocalPerpsAgentSession(nextSession);
        setPerpsAgentSession(nextSession);
      }
      return;
    }

    await fetch("/api/perps/session/status", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${remoteAuthToken}`,
      },
      body: JSON.stringify(input),
    }).catch(() => undefined);
  }, [perpsAgentSession, remoteAuthToken]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!notificationPanelRef.current) return;
      if (notificationPanelRef.current.contains(event.target as Node)) return;
      setNotificationPanelOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  useEffect(() => {
    void refreshPerpsAgentState().catch(() => undefined);
  }, [refreshPerpsAgentState]);

  useEffect(() => {
    if (!remoteAuthToken) return;
    let refreshing = false;
    const intervalId = window.setInterval(() => {
      if (refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      void refreshPerpsExecutionFeed().finally(() => { refreshing = false; });
    }, 20_000);
    return () => window.clearInterval(intervalId);
  }, [refreshPerpsExecutionFeed, remoteAuthToken]);

  useEffect(() => {
    if (!perpsAgentSession || perpsAgentSession.sessionState !== "clocked_in") return;

    const handleVisibility = () => {
      const isVisible = document.visibilityState === "visible";
      if (!isVisible) {
        void sendPerpsSessionHeartbeat({
          appOpen: false,
          appForeground: false,
          walletConnected: wallet.connected || Boolean(jupiterPerpsController?.connected),
          walletWriteEnabled: Boolean(jupiterPerpsController?.canWrite),
          reason: "Trading session is waiting for the app to return to the foreground.",
        });
        return;
      }

      void sendPerpsSessionHeartbeat({
        appOpen: true,
        appForeground: true,
        walletConnected: wallet.connected || Boolean(jupiterPerpsController?.connected),
        walletWriteEnabled: Boolean(jupiterPerpsController?.canWrite),
      });
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [jupiterPerpsController, perpsAgentSession, sendPerpsSessionHeartbeat, wallet.connected]);

  useEffect(() => {
    if (!nativeShell || !perpsAgentSession || perpsAgentSession.sessionState !== "clocked_in") return;

    let cancelled = false;
    void App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        void sendPerpsSessionHeartbeat({
          appOpen: false,
          appForeground: false,
          walletConnected: wallet.connected || Boolean(jupiterPerpsController?.connected),
          walletWriteEnabled: Boolean(jupiterPerpsController?.canWrite),
          reason: "Trading session is waiting for the native app to become active again.",
        });
        return;
      }

      void sendPerpsSessionHeartbeat({
        appOpen: true,
        appForeground: true,
        walletConnected: wallet.connected || Boolean(jupiterPerpsController?.connected),
        walletWriteEnabled: Boolean(jupiterPerpsController?.canWrite),
      });
    }).then((listener) => {
      if (cancelled) {
        void listener.remove().catch(() => undefined);
      }
    }).catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [jupiterPerpsController, nativeShell, perpsAgentSession, sendPerpsSessionHeartbeat, wallet.connected]);

  useEffect(() => {
    if (!perpsAgentSession || perpsAgentSession.sessionState !== "clocked_in") return;
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;

    const heartbeatTimer = window.setInterval(() => {
      void sendPerpsSessionHeartbeat({
        appOpen: true,
        appForeground: true,
        walletConnected: wallet.connected || Boolean(jupiterPerpsController?.connected),
        walletWriteEnabled: Boolean(jupiterPerpsController?.canWrite),
      });
    }, PERPS_HEARTBEAT_REFRESH_MS);

    return () => {
      window.clearInterval(heartbeatTimer);
    };
  }, [jupiterPerpsController, perpsAgentSession, sendPerpsSessionHeartbeat, wallet.connected]);

  useEffect(() => {
    pendingTakeProfitRef.current = pendingTakeProfit;
  }, [pendingTakeProfit]);

  useEffect(() => {
    readOnlyPerpsSnapshotRef.current = readOnlyPerpsSnapshot;
  }, [readOnlyPerpsSnapshot]);

  useEffect(() => {
    if (!activeApprovalId || !jupiterPerpsController) return;

    if (!jupiterPerpsController.connected || !jupiterPerpsController.canWrite) {
      if (approvalConnectStartedRef.current === activeApprovalId) return;
      approvalConnectStartedRef.current = activeApprovalId;
      setActiveApprovalStatus("Opening Jupiter Mobile for approval...");
      void jupiterPerpsController.connect().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Wallet connection failed.";
        setActiveApprovalStatus(message);
      });
      return;
    }

    if (approvalExecutionStartedRef.current === activeApprovalId) return;
    approvalExecutionStartedRef.current = activeApprovalId;
    setActiveApprovalStatus("Submitting pending Perps approval...");

    void (async () => {
      const response = await fetch(`/api/perps/approvals?id=${encodeURIComponent(activeApprovalId)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as
        | { approval?: StoredPerpsApproval; error?: string }
        | null;

      if (!response.ok || !payload?.approval) {
        setActiveApprovalStatus(payload?.error ?? "Approval request could not be loaded.");
        approvalExecutionStartedRef.current = null;
        return;
      }

      const approval = payload.approval;
      if (approval.status === "opened") {
        setActiveApprovalStatus("Approval already executed.");
        return;
      }

      try {
        const result = await jupiterPerpsController.openMarketPosition(approval.request);
        await fetch("/api/perps/approvals", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: approval.id,
            status: "opened",
            openedTxid: result.txid,
          }),
        }).catch(() => undefined);
        await sendSignalNotification(
          `Trade Filled: ${approval.symbol}`,
          `${approval.request.side === "long" ? "Long" : "Short"} executed · ${result.txid.slice(0, 10)}...`,
          "/signals-bot?tab=perps",
          NATIVE_NOTIFICATION_SOUNDS.approval,
        );
        await sendRemotePushNotification({
          title: `Trade Filled: ${approval.symbol}`,
          body: `${approval.request.side === "long" ? "Long" : "Short"} executed · ${result.txid.slice(0, 10)}...`,
          url: "/signals-bot?tab=perps",
          walletAddress: approval.walletAddress,
          sound: NATIVE_NOTIFICATION_SOUNDS.approval,
        });
        setPerpsAutoTradeStatus(
          `Perps approval executed for ${approval.symbol}: ${approval.request.side === "long" ? "long" : "short"} · ${result.txid.slice(0, 10)}...`
        );
        setActiveApprovalStatus("Perps approval executed.");
        clearActiveApprovalState();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unable to execute approval.";
        await fetch("/api/perps/approvals", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: approval.id,
            status: "failed",
            failureReason: message,
          }),
        }).catch(() => undefined);
        setActiveApprovalStatus(message);
        approvalExecutionStartedRef.current = null;
      }
    })();
  }, [activeApprovalId, clearActiveApprovalState, jupiterPerpsController, sendRemotePushNotification, sendSignalNotification]);

  useEffect(() => {
    clearActiveApprovalTimeout();

    if (!activeApprovalId) {
      return;
    }

    activeApprovalTimeoutRef.current = setTimeout(() => {
      const timeoutMessage = "Perps approval timed out after 20 seconds with no action.";
      void fetch("/api/perps/approvals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activeApprovalId,
          status: "cancelled",
          failureReason: timeoutMessage,
        }),
      }).catch(() => undefined);
      setPerpsAutoTradeStatus(timeoutMessage);
      clearActiveApprovalState();
    }, ACTIVE_APPROVAL_TIMEOUT_MS);

    return () => {
      clearActiveApprovalTimeout();
    };
  }, [activeApprovalId, clearActiveApprovalState, clearActiveApprovalTimeout]);

  useEffect(() => {
    if (remoteAuthSource !== "in-app") {
      clearRemoteAuthDisconnectTimeout();
    }
    if (wallet.connected && remoteAuthSource === "in-app") {
      clearRemoteAuthDisconnectTimeout();
    }
    if (wallet.connected && walletAddress && !remoteAuthSource) {
      clearRemoteAuthDisconnectTimeout();
      setRemoteAuthSource("in-app");
    }
    if (!wallet.connected && remoteAuthSource === "in-app") {
      if (remoteAuthDisconnectTimeoutRef.current) return;
      remoteAuthDisconnectTimeoutRef.current = window.setTimeout(() => {
        remoteAuthDisconnectTimeoutRef.current = null;
        setRemoteAuthSource(null);
        setRemoteAuthToken(null);
        setRemoteAuthAddress(null);
        setRemoteAuthStatus("Remote auth pending");
      }, IN_APP_REMOTE_AUTH_GRACE_MS);
    }
  }, [clearRemoteAuthDisconnectTimeout, remoteAuthSource, wallet.connected, walletAddress]);

  useEffect(() => {
    return () => {
      clearRemoteAuthDisconnectTimeout();
    };
  }, [clearRemoteAuthDisconnectTimeout]);

  useEffect(() => {
    const profile = loadLocalLearningProfile(perpsLogWalletAddress);
    if (profile) {
      setDecisionLearningStatus(`Current trained profile for ${shortAddress(profile.walletAddress)}: ${profile.summary}`);
      return;
    }
    setDecisionLearningStatus("Train the wallet-specific agent profile from saved decision history.");
  }, [perpsLogWalletAddress]);

  useEffect(() => {
    if (!perpsAgentSession || perpsAgentSession.sessionState !== "clocked_in") return;

    const hasUserWallet = wallet.connected || Boolean(jupiterPerpsController?.connected);
    const requiresRemoteAuth = !perpsAgentSession.sessionId.startsWith("local-");
    if (!hasUserWallet || (requiresRemoteAuth && !remoteAuthToken)) {
      void sendPerpsSessionHeartbeat({
        appOpen: true,
        appForeground: typeof document === "undefined" ? true : document.visibilityState === "visible",
        walletConnected: hasUserWallet,
        walletWriteEnabled: Boolean(jupiterPerpsController?.canWrite),
        reason: "Trading session is waiting for the wallet session to reconnect.",
      });
    }
  }, [jupiterPerpsController?.canWrite, jupiterPerpsController?.connected, perpsAgentSession, remoteAuthToken, sendPerpsSessionHeartbeat, wallet.connected]);

  useEffect(() => {
    const provider = getPhantomAuthProvider();
    const existingAddress = provider ? extractPhantomPublicKey(provider) : null;
    if (existingAddress) {
      setPhantomAuthAddress((current) => current ?? existingAddress);
    }
  }, []);

  useEffect(() => {
    if (wallet.publicKey || !pendingTakeProfit) return;
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
  }, [pendingTakeProfit, wallet.publicKey]);

  const persistTradeRecord = useCallback(async (trade: StoredTradeRecord) => {
    const activeWallet = trade.walletAddress ?? tradeStorageAddress;
    setRecentTrades((prevTrades) => {
      const nextTrades = [trade, ...prevTrades.filter((item) => item.id !== trade.id)].slice(0, LOCAL_RECENT_TRADES_CAP);
      try {
        window.localStorage.setItem(tradesStorageKey(activeWallet), JSON.stringify(nextTrades));
      } catch (_error) {
        // ignore storage errors
      }
      return nextTrades;
    });

    if (!remoteAuthToken || !remoteAuthAddress || !trade.walletAddress || trade.walletAddress !== remoteAuthAddress) return;
    await fetch("/api/trades", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${remoteAuthToken}`,
      },
      body: JSON.stringify({ trade }),
    }).then(async (response) => {
      if (response.ok) return;
      if (response.status === 401) {
        setRemoteAuthToken(null);
        setRemoteAuthAddress(null);
        setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
      }
    }).catch(() => undefined);
  }, [remoteAuthAddress, remoteAuthToken, tradeStorageAddress]);

  const syncSignalToRemote = useCallback(async (signal: Signal) => {
    if (!remoteAuthToken || !remoteAuthAddress || remoteAuthAddress !== signalStorageAddress) return;
    await fetch("/api/signals", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${remoteAuthToken}`,
      },
      body: JSON.stringify({ signal }),
    }).then((response) => {
      if (response.status === 401) {
        setRemoteAuthToken(null);
        setRemoteAuthAddress(null);
        setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
      }
    }).catch(() => undefined);
  }, [remoteAuthAddress, remoteAuthToken, signalStorageAddress]);

  useEffect(() => {
    let cancelled = false;
    let simulateInterval: ReturnType<typeof setInterval> | null = null;
    let polling = false;
    let consecutiveFailures = 0;
    let nextPollAllowedAt = 0;
    const simulatedFeed = createSimulatedFeed(trackedMarkets.map((market) => market.pair));

    const appendPrices = (
      pricesBySlot: Partial<Record<string, number>>,
      changes24hBySlot: Partial<Record<string, number>>,
      now: number
    ) => {
      setPriceHistory((prev) => {
        const next = { ...prev };
        trackedMarkets.forEach((market) => {
          const price = Number(pricesBySlot[market.id]);
          if (!Number.isFinite(price) || price <= 0) return;
          const existing = next[market.id] ?? [];
          next[market.id] = [...existing, { t: now, v: price }].slice(-5400);

          if (changes24hBySlot[market.id] === undefined && next[market.id].length > 1) {
            const history = next[market.id];
            const current = history[history.length - 1]?.v ?? 0;
            const dayAgo = history.find((point) => now - point.t >= 24 * 60 * 60 * 1000) ?? history[0];
            if (dayAgo && dayAgo.v > 0) {
              changes24hBySlot[market.id] = ((current - dayAgo.v) / dayAgo.v) * 100;
            }
          }
        });
        return next;
      });

      setDayChange24h((prev) => {
        const next = { ...prev };
        trackedMarkets.forEach((market) => {
          const value = changes24hBySlot[market.id];
          if (typeof value === "number" && Number.isFinite(value)) {
            next[market.id] = value;
          }
        });
        return next;
      });
    };

    const startSimulationFallback = () => {
      if (simulateInterval) return;
      setPriceFeedStatus("simulated");
      simulateInterval = setInterval(() => {
        const updates = simulatedFeed();
        const pricesBySlot: Partial<Record<string, number>> = {};
        updates.forEach((update) => {
          const slot = trackedMarkets.find((market) => market.pair === update.symbol);
          if (!slot) return;
          const point = update.points[0];
          if (point) pricesBySlot[slot.id] = point.v;
        });
        appendPrices(pricesBySlot, {}, Date.now());
      }, 1000);
    };

    const stopSimulationFallback = () => {
      if (!simulateInterval) return;
      clearInterval(simulateInterval);
      simulateInterval = null;
    };

    const pollLivePrices = async () => {
      if (polling) return;
      if (Date.now() < nextPollAllowedAt) return;
      polling = true;
      try {
        const products = trackedMarkets.map((market) => market.coinbaseProduct).join(",");
        const response = await fetch(`/api/prices/live?products=${encodeURIComponent(products)}`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (!response.ok || !payload?.markets) {
          consecutiveFailures += 1;
          nextPollAllowedAt = Date.now() + Math.min(
            LIVE_PRICE_MAX_BACKOFF_MS,
            LIVE_PRICE_REFRESH_MS * (2 ** Math.min(consecutiveFailures, 3))
          );
          if (!cancelled) startSimulationFallback();
          return;
        }

        const now = Number(payload.timestamp) || Date.now();
        const source = String(payload.source ?? "unknown");
        const markets = payload.markets as Record<
          string,
          { price?: number; change24hPercent?: number }
        >;
        const pricesBySlot: Partial<Record<string, number>> = {};
        const changes24hBySlot: Partial<Record<string, number>> = {};
        trackedMarkets.forEach((market) => {
          const entry = markets[market.coinbaseProduct];
          if (!entry) return;
          if (typeof entry.price === "number") pricesBySlot[market.id] = entry.price;
          if (typeof entry.change24hPercent === "number") {
            changes24hBySlot[market.id] = entry.change24hPercent;
          }
        });

        if (cancelled) return;
        consecutiveFailures = 0;
        nextPollAllowedAt = 0;
        stopSimulationFallback();
        setPriceFeedStatus(source);
        appendPrices(pricesBySlot, changes24hBySlot, now);
      } catch (_error) {
        consecutiveFailures += 1;
        nextPollAllowedAt = Date.now() + Math.min(
          LIVE_PRICE_MAX_BACKOFF_MS,
          LIVE_PRICE_REFRESH_MS * (2 ** Math.min(consecutiveFailures, 3))
        );
        if (!cancelled) startSimulationFallback();
      } finally {
        polling = false;
      }
    };

    pollLivePrices().catch(() => undefined);
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      pollLivePrices().catch(() => undefined);
    }, LIVE_PRICE_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (simulateInterval) clearInterval(simulateInterval);
    };
  }, [trackedMarkets]);

  useEffect(() => {
    setSignals((prev) => {
      let next = [...prev];
      const targetMarket =
        trackedMarkets.find((market) => market.id === receiveSignalsForSlotId) ?? trackedMarkets[0];
      if (!targetMarket) {
        return next;
      }

      [targetMarket].forEach((market) => {
        const points = priceHistory[market.id] ?? [];
        if (points.length === 0) return;
        const now = points[points.length - 1].t;
        const recentPoints = points.filter(
          (point) => now - point.t <= params.trendWindow * 60 * 1000
        );
        const minimumDataPoints = Math.max(10, params.trendWindow * 2);
        if (recentPoints.length < minimumDataPoints) return;

        const newSignals = detectSignals({
          symbol: market.pair,
          points: recentPoints,
          params,
          lastSignalAt: lastSignalAt[market.id],
        });

        if (newSignals.length > 0) {
          setLastSignalAt((prevTimes) => ({
            ...prevTimes,
            [market.id]: now,
          }));

          newSignals.forEach((signal) => {
            if (next.some((existing) => existing.id === signal.id)) return;
            next = normalizeSignalHistory([signal, ...next]);
            void syncSignalToRemote(signal);

            void sendSignalNotification(`Signal: ${signal.symbol}`, signal.summary, undefined, NATIVE_NOTIFICATION_SOUNDS.signal);

            if (autoTradeEnabled && activeAutoTradeToken) {
              if (autoTradeBusyRef.current) {
                return;
              }
              const isBullSignal = signal.direction === "bullish";
              if (autoTradeSettings.mode === "buy-only" && !isBullSignal) {
                setAutoTradeStatus(`Buy-only mode skipped bearish signal for ${signal.symbol}`);
                return;
              }
              const activeTp = pendingTakeProfitRef.current;
              if (activeTp && !autoTradeSettings.disableTpLock) {
                setAutoTradeStatus(
                  `TP lock active for ${activeTp.tokenSymbol}: waiting for ${formatUsd(activeTp.targetPrice)} before new trades`
                );
                return;
              }
              const activeWallet = wallet.publicKey?.toBase58() ?? "paper-auto";
              const assetSymbol = activeAutoTradeToken.symbol;
              const assetMint = activeAutoTradeToken.mint;
              const inputMint = isBullSignal ? USDC_MINT : assetMint;
              const outputMint = isBullSignal ? assetMint : USDC_MINT;
              if (wallet.publicKey) {
                const availableInput = inputMint === SOL_MINT
                  ? (solBalance ?? 0)
                  : (walletTokens.find((token) => token.mint === inputMint)?.amount ?? 0);
                const assetUsdPrice = inputMint === USDC_MINT
                  ? 1
                  : (walletTokens.find((token) => token.mint === inputMint)?.usdPrice ?? points[points.length - 1]?.v ?? null);
                const tradeAmount = getAutoTradeAllocationAmount({
                  settings: autoTradeSettings,
                  availableInput,
                  inputMint,
                  assetUsdPrice,
                });
                if (!Number.isFinite(tradeAmount) || tradeAmount <= 0) {
                  setAutoTradeStatus(`Signal detected for ${signal.symbol} but no ${isBullSignal ? "USDC" : assetSymbol} balance is available`);
                } else {
                  const sideLabel = isBullSignal ? `buy ${assetSymbol}` : `sell ${assetSymbol}`;
                  setAutoTradeStatus(`Executing auto-trade for ${signal.symbol}: ${sideLabel} (${tradeAmount} ${isBullSignal ? "USDC" : assetSymbol})...`);
                  autoTradeBusyRef.current = true;
                  const marketEntryPrice = points[points.length - 1]?.v ?? 0;
                  wallet.executeSwap({
                    inputMint,
                    outputMint,
                    uiAmount: tradeAmount,
                  }).then((result) => {
                    const shouldArmTp =
                      isBullSignal &&
                      autoTradeSettings.spotTakeProfitValue > 0 &&
                      !autoTradeSettings.disableTpLock;
                    const autoTradeRecord: StoredTradeRecord = {
                      id: `auto-${signal.id}-${Date.now()}`,
                      txid: result.txid,
                      timestamp: Date.now(),
                      walletAddress: activeWallet,
                      source: "auto",
                      signalId: signal.id,
                      inputMint: result.inputMint,
                      outputMint: result.outputMint,
                      inputAmount: result.inputAmount,
                      outputAmount: result.outputAmount,
                      signalSummary: `${signal.summary} · ${isBullSignal ? "buy" : "sell"} ${assetSymbol} · executed ${tradeAmount} ${isBullSignal ? "USDC" : assetSymbol}`,
                      symbol: signal.symbol,
                      entryPrice: Number.isFinite(marketEntryPrice) ? marketEntryPrice : undefined,
                      takeProfitPrice: null,
                      tradeDirection: isBullSignal ? "buy" : "sell",
                      gasless: result.gasless,
                    };
                    persistTradeRecord(autoTradeRecord).catch(() => undefined);
                    if (shouldArmTp) {
                      const executedOutputAmount = Number(result.outputAmount ?? 0);
                      const targetPrice =
                        Number.isFinite(executedOutputAmount) && executedOutputAmount > 0 && Number.isFinite(marketEntryPrice) && marketEntryPrice > 0
                          ? computeSpotTakeProfitTargetPrice({
                              entryPrice: marketEntryPrice,
                              amount: executedOutputAmount,
                              mode: autoTradeSettings.spotTakeProfitMode,
                              value: autoTradeSettings.spotTakeProfitValue,
                            })
                          : null;
                      autoTradeRecord.takeProfitPrice = targetPrice;
                      if (Number.isFinite(executedOutputAmount) && executedOutputAmount > 0 && typeof targetPrice === "number" && Number.isFinite(targetPrice)) {
                        const nextPendingTp: PendingTakeProfit = {
                          id: `tp-${signal.id}-${Date.now()}`,
                          symbol: signal.symbol,
                          tokenSymbol: assetSymbol,
                          tokenMint: assetMint,
                          amount: executedOutputAmount,
                          entryPrice: marketEntryPrice,
                          targetPrice: targetPrice ?? marketEntryPrice,
                          signalId: signal.id,
                          createdAt: Date.now(),
                        };
                        setPendingTakeProfit(nextPendingTp);
                        pendingTakeProfitRef.current = nextPendingTp;
                        setAutoTradeStatus(
                          `TP armed for ${assetSymbol}: sell ${executedOutputAmount.toFixed(6)} at ${formatUsd(targetPrice)} (${formatTakeProfitSetting(autoTradeSettings.spotTakeProfitMode, autoTradeSettings.spotTakeProfitValue)})`
                        );
                      } else {
                        setAutoTradeStatus(`Auto-trade executed for ${signal.symbol} (TP not armed: output amount unavailable)`);
                      }
                    } else {
                      setAutoTradeStatus(
                        `Auto-trade executed for ${signal.symbol}${result.gasless ? " · gasless" : ""}`
                      );
                    }
                    void sendRemotePushNotification({
                      title: `Auto-trade executed: ${signal.symbol}`,
                      body: `Tx: ${result.txid.slice(0, 12)}... · Tap to view on-chain.`,
                      url: `https://solscan.io/tx/${result.txid}`,
                      walletAddress: activeWallet,
                      sound: NATIVE_NOTIFICATION_SOUNDS.signal,
                    });
                  }).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : "swap failed";
                    setAutoTradeStatus(`Auto-trade failed for ${signal.symbol}: ${message}`);
                  }).finally(() => {
                    autoTradeBusyRef.current = false;
                  });
                }
              } else {
                if (autoTradeSettings.spotTakeProfitValue > 0 && isBullSignal) {
                  setAutoTradeStatus("TP requires a connected wallet for live token settlement");
                  return;
                }
                const autoTradeRecord: StoredTradeRecord = {
                  id: `auto-${signal.id}`,
                  txid: `auto-${signal.id}`,
                  timestamp: Date.now(),
                  walletAddress: activeWallet,
                  source: "auto",
                  signalId: signal.id,
                  symbol: signal.symbol,
                  entryPrice: points[points.length - 1]?.v ?? undefined,
                  takeProfitPrice: null,
                  tradeDirection: signal.direction === "bullish" ? "buy" : "sell",
                  signalSummary: `${signal.summary} · ${signal.direction === "bullish" ? "buy" : "sell"} ${assetSymbol} · ${formatAutoTradeAllocationLabel(autoTradeSettings)}`,
                };
                persistTradeRecord(autoTradeRecord).catch(() => undefined);
                setAutoTradeStatus(
                  `Auto-trade paper execution for ${signal.symbol} (${signal.direction === "bullish" ? "buy" : "sell"} ${assetSymbol}, ${formatAutoTradeAllocationLabel(autoTradeSettings)}; connect wallet for live)`
                );
              }
            }

            if (perpsAutoTradeEnabled && activePerpsAutoTradeToken) {
              if (perpsAutoTradeBusyRef.current) {
                return;
              }

              if (isPerpsAutoTradeFailureCooldownActive()) {
                return;
              }

              if (!isSupportedPerpsAutoTradeToken(activePerpsAutoTradeToken.symbol)) {
                setPerpsAutoTradeStatus(`Perps auto-trade does not support ${activePerpsAutoTradeToken.symbol} yet`);
                return;
              }

              if (!perpsAgentSession || perpsAgentSession.sessionState !== "clocked_in") {
                setPerpsAutoTradeStatus(`Perps agent is clocked out for ${signal.symbol}. Clock In before live or paper automation can run.`);
                return;
              }

              const delegatedAgentSession = perpsAgentSession.executionModel === "delegated-ready";
              if (delegatedAgentSession) {
                setPerpsAutoTradeStatus(
                  `Server monitor active for ${activePerpsAutoTradeToken.symbol} · this browser signal is display-only`
                );
                return;
              }
              if (!jupiterPerpsController && !delegatedAgentSession) {
                setPerpsAutoTradeStatus(`Open the Perps panel once so BremLogic can load Jupiter Perps pricing for ${signal.symbol}`);
                return;
              }

              const findActivePerpsPosition = () =>
                readOnlyPerpsSnapshotRef.current.positions.find((position) => position.source !== "mock");

              if (findActivePerpsPosition()) {
                const activePerpsPosition = findActivePerpsPosition();
                setPerpsAutoTradeStatus(
                  `Perps auto-trade is waiting: ${activePerpsPosition?.marketSymbol} ${activePerpsPosition?.side === "long" ? "long" : "short"} already open`
                );
                return;
              }

              const perpsAssetSymbol = activePerpsAutoTradeToken.symbol;
              const isBullSignal = signal.direction === "bullish";
              if (autoTradeSettings.mode === "buy-only" && !isBullSignal) {
                setPerpsAutoTradeStatus(`Buy-only mode skipped bearish Perps signal for ${signal.symbol}`);
                return;
              }

              const usdcBalance = delegatedAgentSession
                ? (readOnlyPerpsSnapshotRef.current.agentAvailableUsdc ?? 0)
                : (walletTokens.find((token) => token.mint === USDC_MINT)?.amount ?? 0);
              const baseCollateralPercent = getAllocationPercentOfBalance(autoTradeSettings, usdcBalance);
              const perpsTradePlan =
                autoTradeSettings.perpsExecutionMode === "smart-trades"
                  ? deriveSmartPerpsTradePlan({
                      points,
                      settings: autoTradeSettings,
                      collateralPercentBase: baseCollateralPercent,
                      signal,
                    })
                  : {
                      collateralPercent: baseCollateralPercent,
                      leverage: autoTradeSettings.perpsLeverage,
                      stopLossPercent: autoTradeSettings.stopLossPercent,
                      takeProfitPercent: autoTradeSettings.perpsTakeProfitMode === "percent" ? autoTradeSettings.perpsTakeProfitValue : 0,
                      volatilityPercent: computeRecentVolatilityPercent(points),
                    };

              const collateralAmount = Number((usdcBalance * (perpsTradePlan.collateralPercent / 100)).toFixed(6));
              if (!Number.isFinite(collateralAmount) || collateralAmount <= 0) {
                setPerpsAutoTradeStatus(`Perps signal detected for ${signal.symbol} but no USDC collateral is available`);
                return;
              }

              void (async () => {
                perpsAutoTradeBusyRef.current = true;

                try {
                  let takeProfitPrice: number | null = null;
                  let stopLossPrice: number | null = null;
                  const marketEntryPrice = points[points.length - 1]?.v ?? 0;

                  if (
                    (autoTradeSettings.perpsTakeProfitValue > 0 || autoTradeSettings.stopLossPercent > 0) &&
                    Number.isFinite(marketEntryPrice) &&
                    marketEntryPrice > 0
                  ) {
                    try {
                      const preview = jupiterPerpsController
                        ? await jupiterPerpsController.previewMarketPosition({
                        asset: perpsAssetSymbol,
                        collateralToken: "USDC",
                        leverage: String(perpsTradePlan.leverage),
                        maxSlippageBps: "100",
                        side: isBullSignal ? "long" : "short",
                        uiAmount: collateralAmount,
                      })
                        : null;

                      if (autoTradeSettings.perpsTakeProfitMode === "percent") {
                        const adjustedTriggers = preview ? deriveFeeAdjustedPerpsTriggers({
                          desiredStopLossPercent: perpsTradePlan.stopLossPercent,
                          desiredTakeProfitPercent: perpsTradePlan.takeProfitPercent,
                          fallbackEntryPrice: marketEntryPrice,
                          preview,
                        }) : {
                          takeProfitPrice: marketEntryPrice * (1 + (isBullSignal ? 1 : -1) * perpsTradePlan.takeProfitPercent / 100 / perpsTradePlan.leverage),
                          stopLossPrice: marketEntryPrice * (1 - (isBullSignal ? 1 : -1) * perpsTradePlan.stopLossPercent / 100 / perpsTradePlan.leverage),
                        };
                        takeProfitPrice = adjustedTriggers.takeProfitPrice;
                        stopLossPrice = adjustedTriggers.stopLossPrice;
                      } else {
                        const previewEntryPrice = preview?.quote.averagePriceUsd ?? marketEntryPrice;
                        const previewPositionSizeUsd = preview?.quote.positionSizeUsd
                          ?? Number((collateralAmount * perpsTradePlan.leverage).toFixed(2));
                        takeProfitPrice = computePerpsTakeProfitTargetPrice({
                          entryPrice: previewEntryPrice,
                          side: isBullSignal ? "long" : "short",
                          positionSizeUsd: previewPositionSizeUsd,
                          mode: autoTradeSettings.perpsTakeProfitMode,
                          value: autoTradeSettings.perpsTakeProfitValue,
                        });
                        stopLossPrice = autoTradeSettings.stopLossPercent > 0
                          ? preview ? deriveFeeAdjustedPerpsTriggers({
                              desiredStopLossPercent: perpsTradePlan.stopLossPercent,
                              desiredTakeProfitPercent: 0,
                              fallbackEntryPrice: marketEntryPrice,
                              preview,
                            }).stopLossPrice : marketEntryPrice * (1 - (isBullSignal ? 1 : -1) * perpsTradePlan.stopLossPercent / 100 / perpsTradePlan.leverage)
                          : null;
                      }
                    } catch (previewError) {
                      const previewMessage =
                        previewError instanceof Error ? previewError.message : "Unable to estimate Perps TP/SL with fees.";
                      setPerpsAutoTradeStatus(`Perps auto-trade paused for ${signal.symbol}: ${previewMessage}`);
                      return;
                    }
                  }

                  const executionRequest: PendingPerpsApprovalRequest = {
                    asset: perpsAssetSymbol,
                    collateralToken: "USDC",
                    leverage: String(perpsTradePlan.leverage),
                    maxSlippageBps: "100",
                    side: isBullSignal ? "long" : "short",
                    stopLossPrice,
                    takeProfitPrice,
                    uiAmount: collateralAmount,
                  };

                  const result = await submitPerpsAgentSignal({
                    signal,
                    request: executionRequest,
                    collateralUsd: collateralAmount,
                    marketContext: {
                      spotPrice: marketEntryPrice > 0 ? marketEntryPrice : null,
                      volatilityPercent: Number(perpsTradePlan.volatilityPercent.toFixed(4)),
                      trendBias: computeRecentTrendBias(points),
                      availableUsdc: usdcBalance,
                      hasOpenPosition: Boolean(findActivePerpsPosition()),
                      recentPriceChangePercent:
                        points.length >= 2 && Number.isFinite(points[0]?.v) && (points[0]?.v ?? 0) > 0
                          ? Number((((points[points.length - 1]?.v ?? 0) - (points[0]?.v ?? 0)) / (points[0]?.v ?? 1) * 100).toFixed(4))
                          : null,
                    },
                  });

                  const preparedResult = result as {
                    ok: boolean;
                    message?: string;
                    preparedAction?: PendingPerpsApprovalRequest;
                    autonomousResult?: {
                      agentWalletAddress: string;
                      positionPubkey: string | null;
                      txid: string;
                    };
                    execution?: PerpsExecutionSummary & { mode: "paper" | "live" };
                  };
                  const execution = preparedResult.execution;
                  if (!execution) {
                    throw new Error("Perps agent did not return an execution record.");
                  }

                  const tradeLabel = `${executionRequest.side === "long" ? "Long" : "Short"} ${perpsAssetSymbol}`;
                  if (execution.mode === "paper") {
                    setPerpsAutoTradeStatus(
                      `Paper mode · Clocked In · ${tradeLabel} logged for ${signal.symbol} (${collateralAmount} USDC at ${perpsTradePlan.leverage}x)`
                    );
                    await sendSignalNotification(
                      `Paper Trade Logged: ${signal.symbol}`,
                      `${tradeLabel} · ${execution.reasonMessage}`,
                      "/signals-bot?tab=perps",
                      NATIVE_NOTIFICATION_SOUNDS.approval,
                    );
                    await sendRemotePushNotification({
                      title: `Paper Trade Logged: ${signal.symbol}`,
                      body: `${tradeLabel} · ${execution.reasonMessage}`,
                      url: "/signals-bot?tab=perps",
                      walletAddress: walletAddress ?? undefined,
                      sound: NATIVE_NOTIFICATION_SOUNDS.approval,
                    });
                    return;
                  }

                  if (preparedResult.autonomousResult) {
                    const autonomous = preparedResult.autonomousResult;
                    await jupiterPerpsController?.refresh().catch(() => undefined);
                    await refreshPerpsAgentState().catch(() => undefined);
                    setPerpsAutoTradeStatus(
                      preparedResult.message
                        ? `Live mode · ${preparedResult.message}`
                        : `Live mode · Agent wallet submitted ${tradeLabel} · ${autonomous.txid.slice(0, 10)}...`
                    );
                    await sendSignalNotification(
                      `Autonomous Trade Submitted: ${signal.symbol}`,
                      preparedResult.message ?? `${tradeLabel} executed through the associated agent wallet.`,
                      "/signals-bot?tab=perps",
                      NATIVE_NOTIFICATION_SOUNDS.approval,
                    );
                    await sendRemotePushNotification({
                      title: `Autonomous Trade Submitted: ${signal.symbol}`,
                      body: preparedResult.message ?? `${tradeLabel} executed through the associated agent wallet.`,
                      url: "/signals-bot?tab=perps",
                      walletAddress: walletAddress ?? undefined,
                      sound: NATIVE_NOTIFICATION_SOUNDS.approval,
                    });
                    return;
                  }

                  if (!preparedResult.preparedAction || !jupiterPerpsController || !jupiterPerpsController.connected || !jupiterPerpsController.canWrite) {
                    throw new Error("Live Perps automation is approval-assisted and requires an active writable Jupiter Mobile session.");
                  }
                  const writablePerpsController = jupiterPerpsController;

                  setPerpsAutoTradeStatus(
                    `Live mode · Clocked In · ${tradeLabel} awaiting your wallet session approval for ${signal.symbol}`
                  );

                  try {
                    const directResult = await writablePerpsController.openMarketPosition(preparedResult.preparedAction);
                    if (remoteAuthToken) {
                      await fetch("/api/perps/executions", {
                        method: "PATCH",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${remoteAuthToken}`,
                        },
                        body: JSON.stringify({
                          executionId: execution.executionId,
                          status: "submitted",
                          txid: directResult.txid,
                          positionPubkey: directResult.positionPubkey ?? null,
                        }),
                      }).catch(() => undefined);
                    }
                    await refreshPerpsAgentState().catch(() => undefined);
                    setPerpsAutoTradeStatus(
                      `Live mode · Clocked In · ${tradeLabel} submitted through your wallet session · ${directResult.txid.slice(0, 10)}...`
                    );
                    await sendSignalNotification(
                      `Live Trade Submitted: ${signal.symbol}`,
                      `${tradeLabel} executed with your wallet session.`,
                      "/signals-bot?tab=perps",
                      NATIVE_NOTIFICATION_SOUNDS.approval,
                    );
                    await sendRemotePushNotification({
                      title: `Live Trade Submitted: ${signal.symbol}`,
                      body: `${tradeLabel} executed with your wallet session.`,
                      url: "/signals-bot?tab=perps",
                      walletAddress: walletAddress ?? undefined,
                      sound: NATIVE_NOTIFICATION_SOUNDS.approval,
                    });
                  } catch (liveError) {
                    if (remoteAuthToken) {
                      await fetch("/api/perps/executions", {
                        method: "PATCH",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${remoteAuthToken}`,
                        },
                        body: JSON.stringify({
                          executionId: execution.executionId,
                          status: "failed",
                          errorMessage: liveError instanceof Error ? liveError.message : "Wallet approval failed.",
                        }),
                      }).catch(() => undefined);
                    }
                    await refreshPerpsAgentState().catch(() => undefined);
                    throw liveError;
                  }
                } catch (error: unknown) {
                  const message = error instanceof Error ? error.message : "Unable to queue Perps approval.";
                  setPerpsAutoTradeFailureCooldown(signal.symbol, message);
                } finally {
                  perpsAutoTradeBusyRef.current = false;
                }
              })();
            }

            void sendRemotePushNotification({
              title: `Signal: ${signal.symbol}`,
              body: signal.summary,
              url: "/signals-bot",
              walletAddress: walletAddress ?? jupiterPerpsController?.walletAddress ?? undefined,
              sound: NATIVE_NOTIFICATION_SOUNDS.signal,
            });
          });
        }
      });

      try {
        window.localStorage.setItem(signalsStorageKey(signalStorageAddress), JSON.stringify(next));
      } catch {
        // The in-memory feed still works if device storage is unavailable.
      }
      return next;
    });
  }, [
    activeAutoTradeToken,
    activePerpsAutoTradeToken,
    autoTradeSettings,
    autoTradeEnabled,
    clearPerpsAutoTradeTimeout,
    getPerpsAutoTradeReadyStatus,
    isPerpsAutoTradeFailureCooldownActive,
    jupiterPerpsController,
    lastSignalAt,
    nativeShell,
    params,
    priceHistory,
    pushEnabled,
    receiveSignalsForSlotId,
    sendRemotePushNotification,
    sendSignalNotification,
    setPerpsAutoTradeFailureCooldown,
    submitPerpsAgentSignal,
    trackedMarkets,
    persistTradeRecord,
    perpsAgentSession,
    perpsAutoTradeEnabled,
    readOnlyPerpsSnapshot.positions,
    refreshPerpsAgentState,
    remoteAuthToken,
    wallet,
    wallet.executeSwap,
    walletAddress,
    wallet.publicKey,
    walletTokens,
    solBalance,
    signalStorageAddress,
    syncSignalToRemote,
  ]);

  useEffect(() => {
    if (nativeShell) {
      let cancelled = false;

      async function initNativeNotifications() {
        const { hasLocalNotifications, hasPushNotifications } = getNativePushPluginStatus();
        if (!hasLocalNotifications) {
          if (!cancelled) {
            setPushReady(false);
            setPushStatus("Native notifications plugin missing in this app build");
          }
          return;
        }

        try {
          const localPermission = await LocalNotifications.checkPermissions();
          const pushPermission = hasPushNotifications
            ? await PushNotifications.checkPermissions()
            : { receive: "prompt" as const };
          if (cancelled) return;
          const enabledPreference = readNativeAlertsEnabled();
          setPushReady(true);
          if (!hasPushNotifications) {
            setPushEnabled(localPermission.display === "granted" && enabledPreference);
            setPushStatus("This installed iPhone app needs a rebuild/reinstall to add APNs push support");
            return;
          }
          if (nativePushIssue && localPermission.display === "granted" && enabledPreference) {
            setPushEnabled(true);
            setPushStatus(`Local native alerts enabled. ${nativePushIssue}`);
            return;
          }
          if (localPermission.display === "granted" && pushPermission.receive === "granted" && enabledPreference) {
            setPushEnabled(true);
            setPushStatus(nativePushToken ? "Native alerts enabled" : "Native alerts enabled, waiting for APNs token");
          } else if (localPermission.display === "granted" || pushPermission.receive === "granted") {
            setPushEnabled(false);
            setPushStatus("Native alerts available");
          } else {
            setPushEnabled(false);
            setPushStatus("Native alerts disabled");
          }
        } catch (error) {
          if (cancelled) return;
          setPushReady(false);
          setPushStatus(error instanceof Error && error.message ? error.message : "Native notifications unavailable");
        }
      }

      void initNativeNotifications();
      return () => {
        cancelled = true;
      };
    }

    if (!window.isSecureContext) {
      setPushStatus("Push requires HTTPS (or localhost)");
      return;
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushStatus("Push is not supported on this browser/device");
      return;
    }

    navigator.serviceWorker
      .register("/sw.js")
      .then(async () => {
        setPushReady(true);
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          setSubscription(existing.toJSON());
          setPushEnabled(true);
          setPushStatus("Alerts enabled");
        } else {
          setPushEnabled(false);
          setPushStatus("Alerts disabled");
        }
      })
      .catch(() => {
        setPushStatus("Service worker registration failed");
      });
  }, [nativePushIssue, nativePushToken, nativeShell]);

  useEffect(() => {
    if (!nativeShell) return;

    let removed = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];

    const registerListener = async (
      promise: Promise<{ remove: () => Promise<void> }>
    ) => {
      try {
        const handle = await promise;
        if (removed) {
          await handle.remove();
          return;
        }
        handles.push(handle);
      } catch {
        // Ignore listener registration failures.
      }
    };

    void registerListener(LocalNotifications.addListener("localNotificationActionPerformed", (event) => {
      const nextUrl = typeof event.notification.extra?.url === "string"
        ? event.notification.extra.url
        : "";
      if (nextUrl) {
        navigateToNotificationUrl(nextUrl);
      }
    }));

    void registerListener(PushNotifications.addListener("registration", (token) => {
      setNativePushIssue(null);
      setNativePushToken(token.value);
        setPushStatus("Native push token ready");
    }));

    void registerListener(PushNotifications.addListener("registrationError", (error) => {
      setNativePushToken(null);
      const message = error.error?.trim() || "APNs registration failed";
      const lowerMessage = message.toLowerCase();
      const profileMessage =
        lowerMessage.includes("aps-environment")
        || lowerMessage.includes("push notifications")
        || lowerMessage.includes("not entitled")
        || lowerMessage.includes("no valid")
          ? "APNs push is unavailable in the current signing profile. Local native alerts still work."
          : message;
      setNativePushIssue(profileMessage);
      setPushEnabled(readNativeAlertsEnabled());
      setPushStatus(`Local native alerts enabled. ${profileMessage}`);
    }));

    void registerListener(PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
      const nextUrl = typeof event.notification.data?.url === "string"
        ? event.notification.data.url
        : "";
      if (nextUrl) {
        navigateToNotificationUrl(nextUrl);
      }
    }));

    void registerListener(PushNotifications.addListener("pushNotificationReceived", (event) => {
      if (typeof event.notification.title === "string") {
        setPushStatus(`Push received: ${event.notification.title}`);
      }
    }));

    return () => {
      removed = true;
      handles.forEach((handle) => {
        void handle.remove();
      });
    };
  }, [navigateToNotificationUrl, nativeShell]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const approvalId = new URLSearchParams(window.location.search).get("approval")?.trim() ?? "";
    if (!approvalId) return;
    setActiveApprovalId(approvalId);
    setActiveApprovalStatus("Opening approval request...");
  }, []);

  useEffect(() => {
    if (!subscription?.endpoint || nativeShell) return;

    fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...subscription,
        walletAddress,
        nativeShell,
        platform: nativeShell ? "native" : "web",
      }),
    }).catch(() => undefined);
  }, [nativeShell, subscription, walletAddress]);

  useEffect(() => {
    if (!nativeShell || !nativePushToken) return;

    fetch("/api/push/native/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: nativePushToken,
        walletAddress,
      }),
    }).catch(() => undefined);
  }, [nativePushToken, nativeShell, walletAddress]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PARAMS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<UserParams>;
      setParams({
        trendWindow: Number(parsed.trendWindow ?? DEFAULT_PARAMS.trendWindow),
        trendThreshold: Number(parsed.trendThreshold ?? DEFAULT_PARAMS.trendThreshold),
        breakoutPercent: Number(parsed.breakoutPercent ?? DEFAULT_PARAMS.breakoutPercent),
        cooldownSeconds: Number(parsed.cooldownSeconds ?? DEFAULT_PARAMS.cooldownSeconds),
      });
      setParamsSaveStatus("Saved preset loaded");
    } catch (_error) {
      setParamsSaveStatus("Failed to load saved preset");
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AUTO_TRADE_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<AutoTradeSettings & { inputToken?: AutoTradeToken; takeProfitPercent?: number }>;
      const walletAllocationMode = parsed.walletAllocationMode === "usd" ? "usd" : "percent";
      const nextPercent = Number(parsed.walletPercent);
      const percent = Number.isFinite(nextPercent)
        ? walletAllocationMode === "usd"
          ? Math.max(0.01, nextPercent)
          : Math.min(100, Math.max(0.01, nextPercent))
        : DEFAULT_AUTO_TRADE_SETTINGS.walletPercent;
      const legacyTakeProfit = Number(parsed.takeProfitPercent);
      const perpsTakeProfitValueRaw = Number(parsed.perpsTakeProfitValue);
      const spotTakeProfitValueRaw = Number(parsed.spotTakeProfitValue);
      const perpsTakeProfitValue = Number.isFinite(perpsTakeProfitValueRaw) && perpsTakeProfitValueRaw >= 0
        ? perpsTakeProfitValueRaw
        : Number.isFinite(legacyTakeProfit) && legacyTakeProfit >= 0
          ? legacyTakeProfit
          : DEFAULT_AUTO_TRADE_SETTINGS.perpsTakeProfitValue;
      const spotTakeProfitValue = Number.isFinite(spotTakeProfitValueRaw) && spotTakeProfitValueRaw >= 0
        ? spotTakeProfitValueRaw
        : Number.isFinite(legacyTakeProfit) && legacyTakeProfit >= 0
          ? legacyTakeProfit
          : DEFAULT_AUTO_TRADE_SETTINGS.spotTakeProfitValue;
      const perpsTakeProfitMode = parsed.perpsTakeProfitMode === "usd" ? "usd" : "percent";
      const spotTakeProfitMode = parsed.spotTakeProfitMode === "usd" ? "usd" : "percent";
      const stopLossPercent = OPERATOR_TRAINING_BASELINE.stopLossRoePercent;
      const nextPerpsLeverage = Number(parsed.perpsLeverage);
      const perpsLeverage = Number.isFinite(nextPerpsLeverage) && nextPerpsLeverage >= 1
        ? Math.min(250, Math.max(1, nextPerpsLeverage))
        : DEFAULT_AUTO_TRADE_SETTINGS.perpsLeverage;
      const mode = parsed.mode === "buy-only" ? "buy-only" : "all";
      const perpsExecutionMode = parsed.perpsExecutionMode === "smart-trades" ? "smart-trades" : "set-parameters";
      const scalpModeEnabled = Boolean(parsed.scalpModeEnabled);
      const parsedScalpTakeProfitRoePercent = Number(parsed.scalpTakeProfitRoePercent);
      const scalpTakeProfitRoePercent = Number.isFinite(parsedScalpTakeProfitRoePercent)
        ? Math.min(100, Math.max(SCALP_MINIMUM_TAKE_PROFIT_ROE_PERCENT, parsedScalpTakeProfitRoePercent))
        : DEFAULT_AUTO_TRADE_SETTINGS.scalpTakeProfitRoePercent;
      const decisionMode = parsed.decisionMode === "shadow" ? "shadow" : "active";
      const smartTradeProfile =
        parsed.smartTradeProfile === "conservative" || parsed.smartTradeProfile === "aggressive"
          ? parsed.smartTradeProfile
          : "balanced";
      const disableTpLock = Boolean(parsed.disableTpLock);
      const parsedSlots = Array.isArray(parsed.slots)
        ? parsed.slots
          .map((slot) => {
            if (!slot || typeof slot !== "object") return null;
            const slotId = String((slot as { id?: string }).id ?? "");
            const tokenRaw = String((slot as { token?: string }).token ?? "SOL");
            const token = AUTO_TRADE_TOKEN_OPTIONS.some((option) => option.symbol === tokenRaw)
              ? (tokenRaw as AutoTradeToken)
              : "SOL";
            return slotId ? { id: slotId, token } : null;
          })
          .filter((slot): slot is AutoTradeSlot => Boolean(slot))
          .slice(0, 3)
        : [];
      const normalizedSlots = parsedSlots.length === 3
        ? parsedSlots
        : DEFAULT_AUTO_TRADE_SETTINGS.slots.map((slot, index) => ({
          ...slot,
          token: parsedSlots[index]?.token ?? slot.token,
        }));
      const legacyInputToken = parsed.inputToken;
      const activeSlotId = typeof parsed.activeSlotId === "string"
        ? normalizedSlots.some((slot) => slot.id === parsed.activeSlotId) ? parsed.activeSlotId : null
        : legacyInputToken
          ? normalizedSlots[0]?.id ?? null
          : null;
      const perpsActiveSlotId = typeof parsed.perpsActiveSlotId === "string"
        ? normalizedSlots.some((slot) => slot.id === parsed.perpsActiveSlotId) ? parsed.perpsActiveSlotId : null
        : null;

      setAutoTradeSettings({
        walletPercent: percent,
        walletAllocationMode,
        perpsTakeProfitValue,
        perpsTakeProfitMode,
        spotTakeProfitValue,
        spotTakeProfitMode,
        stopLossPercent,
        perpsLeverage: perpsExecutionMode === "smart-trades"
          ? OPERATOR_TRAINING_BASELINE.leverageCap
          : perpsLeverage,
        perpsExecutionMode,
        scalpModeEnabled,
        scalpTakeProfitRoePercent,
        decisionMode,
        smartTradeProfile,
        slots: normalizedSlots,
        activeSlotId,
        perpsActiveSlotId,
        mode,
        disableTpLock,
      });
    } catch (_error) {
      setAutoTradeSettings(DEFAULT_AUTO_TRADE_SETTINGS);
    } finally {
      setLocalAutomationSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    autoTradeSettingsRef.current = autoTradeSettings;
  }, [autoTradeSettings]);

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    automationConfigSyncRef.current = automationConfigSync;
  }, [automationConfigSync]);

  const applyRemoteAutomationConfig = useCallback((
    config: PerpsAutomationConfig,
    message: string,
    status: AutomationConfigSyncState["status"] = "synced"
  ) => {
    const nextSettings = config.settings as AutoTradeSettings;
    const snapshot = serializeAutomationConfig(nextSettings, config.params);
    autoTradeSettingsRef.current = nextSettings;
    paramsRef.current = config.params;
    syncedAutomationSnapshotRef.current = snapshot;
    setAutoTradeSettings(nextSettings);
    setParams(config.params);
    setAutomationConfigSync({
      walletAddress: config.walletAddress,
      revision: config.revision,
      updatedAt: config.updatedAt,
      status,
      message,
    });
    setParamsSaveStatus(message);
    try {
      window.localStorage.setItem(walletAutoTradeSettingsStorageKey(config.walletAddress), JSON.stringify(nextSettings));
      window.localStorage.setItem(walletParamsStorageKey(config.walletAddress), JSON.stringify(config.params));
    } catch {
      // The wallet-scoped cache is optional; Redis remains authoritative.
    }
  }, []);

  useEffect(() => {
    const configWalletAddress = remoteAuthAddress ?? remoteSyncWalletAddress;
    if (!remoteAuthToken || !configWalletAddress || !localAutomationSettingsLoaded) {
      syncedAutomationSnapshotRef.current = null;
      setAutomationConfigSync({
        walletAddress: null,
        revision: 0,
        updatedAt: null,
        status: "idle",
        message: remoteSyncWalletAddress
          ? "Authenticate this wallet to sync master controls."
          : "Connect a wallet to sync master controls.",
      });
      return;
    }

    let cancelled = false;
    syncedAutomationSnapshotRef.current = null;
    setAutomationConfigSync({
      walletAddress: configWalletAddress,
      revision: 0,
      updatedAt: null,
      status: "loading",
      message: "Loading wallet master controls...",
    });

    const refreshConfig = async (initial = false) => {
      try {
        const response = await fetch("/api/perps/automation/config", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${remoteAuthToken}` },
        });
        const payload = await response.json().catch(() => null) as {
          config?: PerpsAutomationConfig | null;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error || "Unable to load wallet master controls.");
        if (cancelled) return;

        const config = payload?.config ?? null;
        const currentSync = automationConfigSyncRef.current;
        if (!config) {
          if (initial || currentSync.walletAddress !== configWalletAddress) {
            syncedAutomationSnapshotRef.current = null;
            setAutomationConfigSync({
              walletAddress: configWalletAddress,
              revision: 0,
              updatedAt: null,
              status: "ready",
              message: "Creating wallet master controls...",
            });
          }
          return;
        }

        const shouldApply = initial
          || currentSync.walletAddress !== configWalletAddress
          || config.revision > currentSync.revision;
        if (shouldApply) {
          const currentSnapshot = serializeAutomationConfig(autoTradeSettingsRef.current, paramsRef.current);
          const hadUnsavedChanges = Boolean(
            syncedAutomationSnapshotRef.current
            && syncedAutomationSnapshotRef.current !== currentSnapshot
          );
          applyRemoteAutomationConfig(
            config,
            hadUnsavedChanges
              ? "Newer wallet settings were loaded; stale device edits were discarded."
              : "Synced to wallet",
            hadUnsavedChanges ? "conflict" : "synced"
          );
        } else if (currentSync.status === "error") {
          setAutomationConfigSync((current) => ({
            ...current,
            status: "synced",
            message: "Synced to wallet",
          }));
        }
      } catch (error) {
        if (cancelled) return;
        setAutomationConfigSync((current) => ({
          ...current,
          walletAddress: configWalletAddress,
          status: "error",
          message: error instanceof Error ? error.message : "Wallet master-control sync failed.",
        }));
      }
    };

    const handleForegroundRefresh = () => {
      if (document.visibilityState === "visible") void refreshConfig();
    };
    void refreshConfig(true);
    const intervalId = window.setInterval(() => { void refreshConfig(); }, AUTOMATION_CONFIG_REFRESH_MS);
    document.addEventListener("visibilitychange", handleForegroundRefresh);
    window.addEventListener("focus", handleForegroundRefresh);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleForegroundRefresh);
      window.removeEventListener("focus", handleForegroundRefresh);
    };
  }, [applyRemoteAutomationConfig, localAutomationSettingsLoaded, remoteAuthAddress, remoteAuthToken, remoteSyncWalletAddress]);

  useEffect(() => {
    const configWalletAddress = remoteAuthAddress ?? remoteSyncWalletAddress;
    if (!remoteAuthToken || !configWalletAddress) return;
    if (automationConfigSync.walletAddress !== configWalletAddress) return;
    if (!["ready", "synced", "conflict"].includes(automationConfigSync.status)) return;

    const snapshot = serializeAutomationConfig(autoTradeSettings, params);
    if (snapshot === syncedAutomationSnapshotRef.current) return;
    const expectedRevision = automationConfigSync.revision;
    let cancelled = false;
    let requestStarted = false;

    const timeoutId = window.setTimeout(() => {
      requestStarted = true;
      setAutomationConfigSync((current) => ({
        ...current,
        status: "saving",
        message: "Saving wallet master controls...",
      }));
      void fetch("/api/perps/automation/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${remoteAuthToken}`,
        },
        body: JSON.stringify({
          settings: autoTradeSettings,
          params,
          expectedRevision,
        }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => null) as {
          config?: PerpsAutomationConfig | null;
          error?: string;
        } | null;
        if (cancelled || automationConfigSyncRef.current.walletAddress !== configWalletAddress) return;
        if (response.status === 409 && payload?.config) {
          applyRemoteAutomationConfig(
            payload.config,
            "Another device saved newer settings. The wallet version was loaded.",
            "conflict"
          );
          return;
        }
        if (!response.ok || !payload?.config) {
          throw new Error(payload?.error || "Unable to save wallet master controls.");
        }

        const savedConfig = payload.config;
        syncedAutomationSnapshotRef.current = snapshot;
        try {
          window.localStorage.setItem(walletAutoTradeSettingsStorageKey(configWalletAddress), JSON.stringify(savedConfig.settings));
          window.localStorage.setItem(walletParamsStorageKey(configWalletAddress), JSON.stringify(savedConfig.params));
        } catch {
          // The wallet-scoped cache is optional; Redis remains authoritative.
        }
        const currentSnapshot = serializeAutomationConfig(autoTradeSettingsRef.current, paramsRef.current);
        setAutomationConfigSync({
          walletAddress: configWalletAddress,
          revision: savedConfig.revision,
          updatedAt: savedConfig.updatedAt,
          status: currentSnapshot === snapshot ? "synced" : "ready",
          message: currentSnapshot === snapshot ? "Synced to wallet" : "Saving newer wallet edits...",
        });
        if (currentSnapshot === snapshot) setParamsSaveStatus("Synced to wallet");
      }).catch((error) => {
        if (cancelled || automationConfigSyncRef.current.walletAddress !== configWalletAddress) return;
        setAutomationConfigSync((current) => ({
          ...current,
          status: "error",
          message: error instanceof Error ? error.message : "Wallet master-control save failed.",
        }));
      });
    }, 650);

    return () => {
      if (!requestStarted) cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    applyRemoteAutomationConfig,
    autoTradeSettings,
    automationConfigSync.revision,
    automationConfigSync.status,
    automationConfigSync.walletAddress,
    params,
    remoteAuthAddress,
    remoteAuthToken,
    remoteSyncWalletAddress,
  ]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/markets/coinbase", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        const options = Array.isArray(payload?.options) ? (payload.options as MarketOption[]) : [];
        if (options.length > 0) {
          setMarketOptions(options);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!autoTradeSettings.disableTpLock || !pendingTakeProfit) return;
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
  }, [autoTradeSettings.disableTpLock, pendingTakeProfit]);

  useEffect(() => {
    if (!activeAutoTradeToken) {
      setAutoTradeStatus("Auto-trade is off");
      return;
    }
    if (pendingTakeProfit && !autoTradeSettings.disableTpLock) {
      setAutoTradeStatus(
        `TP armed for ${pendingTakeProfit.tokenSymbol}: waiting for ${formatUsd(pendingTakeProfit.targetPrice)} to sell ${pendingTakeProfit.amount.toFixed(6)}`
      );
      return;
    }
    setAutoTradeStatus(
      `Auto-trade is on (${activeAutoTradeToken.symbol}, ${formatAutoTradeAllocationLabel(autoTradeSettings)}, ${autoTradeSettings.mode === "buy-only" ? "Buy Only" : "All"})`
    );
  }, [
    activeAutoTradeToken,
    autoTradeSettings.disableTpLock,
    autoTradeSettings.mode,
    autoTradeSettings,
    pendingTakeProfit,
  ]);

  useEffect(() => {
    if (!activePerpsAutoTradeToken) {
      clearPerpsAutoTradeFailureCooldown();
      clearPerpsAutoTradeTimeout();
      perpsAutoTradeAttemptIdRef.current += 1;
      perpsAutoTradeBusyRef.current = false;
      setPerpsAutoTradeStatus("Perps auto-trade is off");
      return;
    }

    if (!isSupportedPerpsAutoTradeToken(activePerpsAutoTradeToken.symbol)) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol, { unsupported: true }));
      return;
    }

    if (perpsAgentSession?.executionModel === "delegated-ready" && perpsAgentSession.sessionState === "clocked_in") {
      setPerpsAutoTradeStatus(
        `Server monitor active for ${activePerpsAutoTradeToken.symbol} · checks every minute · app may close`
      );
      return;
    }

    if (!jupiterPerpsController?.connected || !jupiterPerpsController.canWrite) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol, { waitingForWallet: true }));
      return;
    }

    if (readOnlyPerpsSnapshot.positions.length > 0) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol, { activePositionLabel: "active position open" }));
      return;
    }

    if (isPerpsAutoTradeFailureCooldownActive()) {
      return;
    }

    if (!perpsAutoTradeBusyRef.current) {
      setPerpsAutoTradeStatus(getPerpsAutoTradeReadyStatus(activePerpsAutoTradeToken.symbol));
    }
  }, [
    activePerpsAutoTradeToken,
    autoTradeSettings.mode,
    autoTradeSettings.perpsLeverage,
    autoTradeSettings,
    clearPerpsAutoTradeFailureCooldown,
    clearPerpsAutoTradeTimeout,
    getPerpsAutoTradeReadyStatus,
    isPerpsAutoTradeFailureCooldownActive,
    jupiterPerpsController,
    perpsAgentSession?.executionModel,
    perpsAgentSession?.sessionState,
    readOnlyPerpsSnapshot.positions.length,
  ]);

  useEffect(() => {
    return () => {
      clearPerpsAutoTradeFailureCooldown();
      clearPerpsAutoTradeTimeout();
      perpsAutoTradeAttemptIdRef.current = 0;
      perpsAutoTradeBusyRef.current = false;
    };
  }, [clearPerpsAutoTradeFailureCooldown, clearPerpsAutoTradeTimeout]);

  useEffect(() => {
    if (nativeShell || typeof window === "undefined") return;

    const shouldKeepAwake = autoTradeEnabled || perpsAutoTradeEnabled;
    const wakeLockApi = (navigator as Navigator & {
      wakeLock?: {
        request?: (type: "screen") => Promise<{ release?: () => Promise<void> }>;
      };
    }).wakeLock;

    if (!shouldKeepAwake || typeof wakeLockApi?.request !== "function") {
      if (wakeLockRef.current) {
        void wakeLockRef.current.release?.().catch(() => undefined);
        wakeLockRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const requestWakeLock = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        wakeLockRef.current = await wakeLockApi.request("screen");
      } catch {
        wakeLockRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !wakeLockRef.current) {
        void requestWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      if (!cancelled && wakeLockRef.current) {
        void wakeLockRef.current.release?.().catch(() => undefined);
      } else if (wakeLockRef.current) {
        void wakeLockRef.current.release?.().catch(() => undefined);
      }
      wakeLockRef.current = null;
    };
  }, [autoTradeEnabled, nativeShell, perpsAutoTradeEnabled]);

  const requestRemoteAuthChallenge = useCallback(async (address: string) => {
    const response = await fetch("/api/trades/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const payload = (await response.json().catch(() => null)) as RemoteAuthChallenge | { error?: string } | null;
    if (!response.ok || !payload || !("challengeId" in payload) || !payload.challengeId || !payload.message) {
      throw new Error((payload && "error" in payload && payload.error) || "Remote auth challenge failed");
    }
    return payload;
  }, []);

  const verifyRemoteAuthChallenge = useCallback(async (address: string, challengeId: string, signature: string) => {
    const response = await fetch("/api/trades/auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, challengeId, signature }),
    });
    const payload = (await response.json().catch(() => null)) as { token?: string; error?: string } | null;
    if (!response.ok || !payload?.token) {
      throw new Error(payload?.error || "Remote auth verification failed");
    }
    return payload.token;
  }, []);

  const signRemoteAuthMessage = useCallback(async (source: RemoteAuthSource, message: string) => {
    const encodedMessage = new TextEncoder().encode(message);

    if (source === "walletconnect") {
      if (!jupiterPerpsController?.connected || !jupiterPerpsController.signMessage) {
        throw new Error("WalletConnect is not ready to authenticate this Mac session.");
      }
      return bs58.encode(await jupiterPerpsController.signMessage(encodedMessage));
    }

    if (source === "in-app") {
      const signature = await walletSignMessage(encodedMessage);
      return bs58.encode(signature);
    }

    const provider = getPhantomAuthProvider();
    if (!provider) {
      throw new Error("Phantom is not available for message signing on this device.");
    }
    const signed = await provider.signMessage(encodedMessage, "utf8");
    const signatureBytes = signed instanceof Uint8Array
      ? signed
      : signed?.signature instanceof Uint8Array
        ? signed.signature
        : null;
    if (!signatureBytes) {
      throw new Error("Phantom did not return a signature.");
    }
    return bs58.encode(signatureBytes);
  }, [jupiterPerpsController, walletSignMessage]);

  const completeRemoteAuth = useCallback(async (address: string, source: RemoteAuthSource) => {
    setRemoteAuthStatus(`Requesting ${remoteAuthSourceLabel(source)} signature...`);
    const challenge = await requestRemoteAuthChallenge(address);
    const signature = await signRemoteAuthMessage(source, challenge.message);
    const nextToken = await verifyRemoteAuthChallenge(address, challenge.challengeId, signature);
    setRemoteAuthToken(nextToken);
    setRemoteAuthAddress(address);
    try {
      window.localStorage.setItem(remoteTradesAuthStorageKey(address), nextToken);
    } catch {
      // ignore storage errors
    }
    setRemoteAuthStatus(`Remote auth connected via ${remoteAuthSourceLabel(source)}`);
    return nextToken;
  }, [requestRemoteAuthChallenge, signRemoteAuthMessage, verifyRemoteAuthChallenge]);

  useEffect(() => {
    const connectedAddress = jupiterPerpsController?.connected
      ? jupiterPerpsController.walletAddress
      : null;

    if (nativeMacShell && connectedAddress) {
      if (remoteAuthSource !== "walletconnect") {
        setRemoteAuthSource("walletconnect");
        setRemoteAuthToken(null);
        setRemoteAuthAddress(null);
      }
      return;
    }

    if (remoteAuthSource === "walletconnect") {
      setRemoteAuthSource(null);
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setRemoteAuthStatus("Remote auth pending");
      setRemoteSyncStatus("Remote sync unavailable");
    }
  }, [jupiterPerpsController?.connected, jupiterPerpsController?.walletAddress, nativeMacShell, remoteAuthSource]);

  async function connectPhantomForRemoteSync() {
    const provider = getPhantomAuthProvider();
    if (!provider) {
      setRemoteAuthStatus("Phantom extension/app browser not detected for remote sync");
      return;
    }

    try {
      setRemoteAuthStatus("Connecting Phantom for remote sync...");
      const result = await provider.connect({ onlyIfTrusted: false }).catch(() => provider.connect());
      const nextAddress =
        extractPhantomPublicKey(provider)
        ?? (result?.publicKey && typeof result.publicKey.toBase58 === "function" ? result.publicKey.toBase58() : null);
      if (!nextAddress) {
        throw new Error("Phantom connected, but no wallet address was returned.");
      }

      setPhantomAuthAddress(nextAddress);
      setRemoteAuthSource("phantom");
      await completeRemoteAuth(nextAddress, "phantom");
    } catch (connectError) {
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      const message = connectError instanceof Error ? connectError.message : "Phantom connection failed";
      setRemoteAuthStatus(message);
    }
  }

  async function disconnectPhantomForRemoteSync() {
    const provider = getPhantomAuthProvider();
    try {
      await provider?.disconnect?.();
    } catch {
      // ignore provider disconnect failures
    }
    if (phantomAuthAddress) {
      try {
        window.localStorage.removeItem(remoteTradesAuthStorageKey(phantomAuthAddress));
      } catch {
        // ignore storage errors
      }
    }
    setPhantomAuthAddress(null);
    if (remoteAuthSource === "phantom") {
      setRemoteAuthSource(wallet.connected && walletAddress ? "in-app" : null);
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setRemoteAuthStatus(wallet.connected && walletAddress ? "In-app wallet ready for remote auth" : "Remote auth pending");
      setRemoteSyncStatus(wallet.connected && walletAddress ? "Remote sync waiting for auth" : "Remote sync unavailable");
    }
  }

  useEffect(() => {
    if (!pendingTakeProfit || !wallet.publicKey || !autoTradeEnabled) return;
    if (autoTradeBusyRef.current) return;

    const market = trackedMarkets.find((item) => item.pair === pendingTakeProfit.symbol);
    if (!market) return;
    const latestPrice = priceHistory[market.id]?.[priceHistory[market.id].length - 1]?.v ?? 0;
    if (!Number.isFinite(latestPrice) || latestPrice <= 0) return;
    if (latestPrice < pendingTakeProfit.targetPrice) return;

    const now = Date.now();
    if (now - lastTpAttemptAtRef.current < 15000) return;
    lastTpAttemptAtRef.current = now;
    autoTradeBusyRef.current = true;

    setAutoTradeStatus(
      `TP hit for ${pendingTakeProfit.tokenSymbol}: selling ${pendingTakeProfit.amount.toFixed(6)} at ${formatUsd(latestPrice)}`
    );

      walletExecuteSwap({
        inputMint: pendingTakeProfit.tokenMint,
        outputMint: USDC_MINT,
        uiAmount: pendingTakeProfit.amount,
    }).then((result) => {
      const tpTradeRecord: StoredTradeRecord = {
        id: `tp-${pendingTakeProfit.id}-${Date.now()}`,
        txid: result.txid,
        timestamp: Date.now(),
        walletAddress: walletPublicKey?.toBase58() ?? "paper-auto",
        source: "auto",
        signalId: pendingTakeProfit.signalId,
        inputMint: result.inputMint,
        outputMint: result.outputMint,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        symbol: pendingTakeProfit.symbol,
        entryPrice: pendingTakeProfit.entryPrice,
        takeProfitPrice: pendingTakeProfit.targetPrice,
        tradeDirection: "sell",
        gasless: result.gasless,
        signalSummary: `TP sell ${pendingTakeProfit.tokenSymbol} at ${formatUsd(latestPrice)} (target ${formatUsd(pendingTakeProfit.targetPrice)})`,
      };
      persistTradeRecord(tpTradeRecord).catch(() => undefined);
      setPendingTakeProfit(null);
      pendingTakeProfitRef.current = null;
      setAutoTradeStatus(`TP executed for ${pendingTakeProfit.symbol} at ${formatUsd(latestPrice)}`);
      void sendSignalNotification(
        `TP Hit: ${pendingTakeProfit.symbol}`,
        `${pendingTakeProfit.tokenSymbol} take profit executed at ${formatUsd(latestPrice)}.`,
        "/signals-bot?tab=trades",
        NATIVE_NOTIFICATION_SOUNDS.tp,
      );
      void sendRemotePushNotification({
        title: `TP Hit: ${pendingTakeProfit.symbol}`,
        body: `${pendingTakeProfit.tokenSymbol} take profit executed at ${formatUsd(latestPrice)}.`,
        url: "/signals-bot?tab=trades",
        walletAddress: walletPublicKey?.toBase58() ?? walletAddress ?? undefined,
        sound: NATIVE_NOTIFICATION_SOUNDS.tp,
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "swap failed";
      setAutoTradeStatus(`TP execution failed for ${pendingTakeProfit.symbol}: ${message}`);
    }).finally(() => {
      autoTradeBusyRef.current = false;
    });
  }, [
    autoTradeEnabled,
    pendingTakeProfit,
    persistTradeRecord,
    priceHistory,
    sendRemotePushNotification,
    sendSignalNotification,
    trackedMarkets,
    wallet.publicKey,
    walletExecuteSwap,
    walletPublicKey,
    walletAddress,
  ]);

  useEffect(() => {
    const activeTradeKey = tradesStorageKey(tradeStorageAddress);
    try {
      const raw = window.localStorage.getItem(activeTradeKey);
      if (!raw) {
        setRecentTrades([]);
        return;
      }
      const parsed = JSON.parse(raw) as StoredTradeRecord[];
      setRecentTrades(Array.isArray(parsed) ? parsed : []);
    } catch (_error) {
      setRecentTrades([]);
    }
  }, [tradeStorageAddress]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(signalsStorageKey(signalStorageAddress));
      const parsed = raw ? JSON.parse(raw) : [];
      setSignals(normalizeSignalHistory(Array.isArray(parsed) ? parsed : []));
    } catch {
      setSignals([]);
    }
  }, [signalStorageAddress]);

  useEffect(() => {
    if (!remoteAuthSource || !remoteSyncWalletAddress) {
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setRemoteAuthStatus("Remote auth pending");
      setRemoteSyncStatus("Remote sync unavailable");
      return;
    }

    const walletAddressForAuth = remoteSyncWalletAddress;
    const authSourceForSync = remoteAuthSource;
    let cancelled = false;
    const cachedToken = typeof window !== "undefined"
      ? window.localStorage.getItem(remoteTradesAuthStorageKey(walletAddressForAuth))
      : null;

    if (cachedToken && remoteAuthAddress === walletAddressForAuth && remoteAuthToken === cachedToken) {
      setRemoteAuthStatus(`Remote auth connected via ${remoteAuthSourceLabel(authSourceForSync)}`);
      return;
    }

    if (authSourceForSync === "phantom") {
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setRemoteAuthStatus(
        phantomAuthAddress
          ? "Tap Sign In with Phantom Sync to finish remote auth."
          : "Connect Phantom Sync to use Phantom for remote auth."
      );
      return;
    }

    async function authenticate() {
      try {
        const nextToken = await completeRemoteAuth(walletAddressForAuth, authSourceForSync);
        if (cancelled) return;
        setRemoteAuthToken(nextToken);
      } catch (authError) {
        if (cancelled) return;
        setRemoteAuthToken(null);
        setRemoteAuthAddress(null);
        const message = authError instanceof Error ? authError.message : "Remote auth failed";
        setRemoteAuthStatus(message);
      }
    }

    if (cachedToken) {
      setRemoteAuthToken(cachedToken);
      setRemoteAuthAddress(walletAddressForAuth);
      setRemoteAuthStatus(`Remote auth connected via ${remoteAuthSourceLabel(authSourceForSync)}`);
      return;
    }

    void authenticate();

    return () => {
      cancelled = true;
    };
  }, [completeRemoteAuth, phantomAuthAddress, remoteAuthAddress, remoteAuthSource, remoteAuthToken, remoteSyncWalletAddress]);

  useEffect(() => {
    if (!remoteSyncWalletAddress || !remoteAuthToken) {
      setRemoteSyncStatus(remoteSyncWalletAddress ? "Remote sync waiting for auth" : "Remote sync unavailable");
      return;
    }

    let cancelled = false;
    setRemoteSyncStatus("Syncing remote trades...");
    fetch(`/api/trades?address=${remoteSyncWalletAddress}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${remoteAuthToken}` },
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (cancelled) return;
      if (!response.ok) {
        if (response.status === 401) {
          try {
            window.localStorage.removeItem(remoteTradesAuthStorageKey(remoteSyncWalletAddress));
          } catch {
            // ignore storage errors
          }
          setRemoteAuthToken(null);
          setRemoteAuthAddress(null);
          setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
        }
        setRemoteSyncStatus("Remote sync failed");
        return;
      }
      const remoteTrades = Array.isArray(payload?.trades) ? (payload.trades as StoredTradeRecord[]) : [];
      setRecentTrades(remoteTrades);
      try {
        window.localStorage.setItem(tradesStorageKey(tradeStorageAddress), JSON.stringify(remoteTrades));
      } catch (_error) {
        // ignore storage errors
      }
      setRemoteSyncStatus(`Remote sync connected (${remoteTrades.length} trades)`);
    }).catch(() => {
      if (cancelled) return;
      setRemoteSyncStatus("Remote sync failed");
    });

    return () => {
      cancelled = true;
    };
  }, [remoteAuthToken, remoteSyncWalletAddress, tradeStorageAddress]);

  useEffect(() => {
    if (!remoteSyncWalletAddress || !remoteAuthToken || remoteSyncWalletAddress !== signalStorageAddress) return;
    let cancelled = false;
    fetch(`/api/signals?address=${encodeURIComponent(remoteSyncWalletAddress)}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${remoteAuthToken}` },
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (cancelled) return;
      if (!response.ok) {
        if (response.status === 401) {
          setRemoteAuthToken(null);
          setRemoteAuthAddress(null);
          setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
        }
        return;
      }
      let localSignals: unknown[] = [];
      try {
        const localRaw = window.localStorage.getItem(signalsStorageKey(signalStorageAddress));
        const parsedLocal = localRaw ? JSON.parse(localRaw) : [];
        localSignals = Array.isArray(parsedLocal) ? parsedLocal : [];
      } catch {
        localSignals = [];
      }
      const merged = normalizeSignalHistory([
        ...localSignals,
        ...(Array.isArray(payload?.signals) ? payload.signals : []),
      ]);
      setSignals(merged);
      window.localStorage.setItem(signalsStorageKey(signalStorageAddress), JSON.stringify(merged));
      if (merged.length > 0) {
        await fetch("/api/signals", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${remoteAuthToken}`,
          },
          body: JSON.stringify({ signals: merged }),
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [remoteAuthToken, remoteSyncWalletAddress, signalStorageAddress]);

  const refreshWalletPortfolio = useCallback(async () => {
    const portfolioPublicKey = portfolioWalletAddress ? new PublicKey(portfolioWalletAddress) : null;
    if (!portfolioPublicKey) {
      setSolBalance(null);
      setWalletTokens([]);
      setTotalBalanceUsd(null);
      setSolValueUsd(null);
      setPortfolioStatus("Wallet not connected");
      return;
    }

    setPortfolioStatus("Syncing wallet balances...");

    try {
      const response = await fetch(`/api/wallet/balances?address=${portfolioPublicKey.toBase58()}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload) {
        setSolBalance(typeof payload.solBalance === "number" ? payload.solBalance : null);
        setWalletTokens(Array.isArray(payload.tokens) ? (payload.tokens as WalletTokenHolding[]) : []);
        setTotalBalanceUsd(typeof payload.totalBalanceUsd === "number" ? payload.totalBalanceUsd : null);
        setSolValueUsd(typeof payload.solValueUsd === "number" ? payload.solValueUsd : null);
        setPortfolioStatus(typeof payload.status === "string" ? payload.status : "Wallet synced");
        return;
      }
    } catch (_error) {
      // fallback to direct client RPC calls below
    }

    const [balanceResult, splTokenAccountsResult, token2022AccountsResult] = await Promise.allSettled([
      connection.getBalance(portfolioPublicKey, "processed"),
      connection.getParsedTokenAccountsByOwner(portfolioPublicKey, {
        programId: TOKEN_PROGRAM_ID,
      }),
      connection.getParsedTokenAccountsByOwner(portfolioPublicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    ]);

    let solLoaded = false;
    let tokensLoaded = false;

    if (balanceResult.status === "fulfilled") {
      setSolBalance(balanceResult.value / 1_000_000_000);
      solLoaded = true;
    } else {
      try {
        const accountInfo = await connection.getAccountInfo(portfolioPublicKey, "finalized");
        if (accountInfo) {
          setSolBalance(accountInfo.lamports / 1_000_000_000);
          solLoaded = true;
        } else {
          setSolBalance(null);
        }
      } catch (_error) {
        setSolBalance(null);
      }
    }

    const holdingsByMint = new Map<string, WalletTokenHolding>();
    const tokenResults = [splTokenAccountsResult, token2022AccountsResult];
    tokenResults.forEach((result) => {
      if (result.status !== "fulfilled") {
        return;
      }
      tokensLoaded = true;
      result.value.value.forEach((accountInfo) => {
        const parsedInfo = accountInfo.account.data.parsed?.info;
        const mint = String(parsedInfo?.mint ?? "");
        const uiAmount = Number(parsedInfo?.tokenAmount?.uiAmount ?? 0);
        const uiAmountString = Number(parsedInfo?.tokenAmount?.uiAmountString ?? 0);
        const amount = Number.isFinite(uiAmount) && uiAmount > 0 ? uiAmount : uiAmountString;

        if (!mint || !Number.isFinite(amount) || amount <= 0) {
          return;
        }

        const existing = holdingsByMint.get(mint);
        holdingsByMint.set(mint, {
          mint,
          amount: (existing?.amount ?? 0) + amount,
        });
      });
    });

    const holdings = [...holdingsByMint.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);
    setWalletTokens(holdings);
    setTotalBalanceUsd(null);
    setSolValueUsd(null);

    if (solLoaded && tokensLoaded) {
      setPortfolioStatus("Wallet synced");
      return;
    }
    if (solLoaded && !tokensLoaded) {
      setPortfolioStatus("SOL balance synced (token accounts unavailable)");
      return;
    }
    if (!solLoaded && tokensLoaded) {
      setPortfolioStatus("Token balances synced (SOL balance unavailable)");
      return;
    }
    setPortfolioStatus("Failed to sync wallet balances");
  }, [connection, portfolioWalletAddress]);

  useEffect(() => {
    refreshWalletPortfolio().catch(() => undefined);
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      refreshWalletPortfolio().catch(() => undefined);
    }, WALLET_PORTFOLIO_REFRESH_MS);

    return () => clearInterval(interval);
  }, [refreshWalletPortfolio]);

  const refreshAgentWalletPortfolio = useCallback(async () => {
    let agentWalletAddress = readOnlyPerpsSnapshot.agentWalletAddress;
    if (!agentWalletAddress && remoteAuthToken) {
      try {
        const associationResponse = await fetch("/api/perps/portfolio", {
          cache: "no-store",
          headers: { Authorization: `Bearer ${remoteAuthToken}` },
        });
        const association = await associationResponse.json().catch(() => null);
        agentWalletAddress = associationResponse.ok && typeof association?.agentWalletAddress === "string"
          ? association.agentWalletAddress
          : null;
      } catch {
        agentWalletAddress = null;
      }
    }

    if (!agentWalletAddress) {
      setAgentPortfolioWalletAddress(null);
      setAgentSolBalance(null);
      setAgentWalletTokens([]);
      setAgentTotalBalanceUsd(null);
      setAgentSolValueUsd(null);
      setAgentPortfolioStatus("Agent wallet not associated");
      return;
    }

    setAgentPortfolioWalletAddress(agentWalletAddress);
    setAgentPortfolioStatus("Syncing agent wallet balances...");
    try {
      const response = await fetch(`/api/wallet/balances?address=${encodeURIComponent(agentWalletAddress)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw new Error("Agent wallet sync failed");
      setAgentSolBalance(typeof payload.solBalance === "number" ? payload.solBalance : null);
      setAgentWalletTokens(Array.isArray(payload.tokens) ? (payload.tokens as WalletTokenHolding[]) : []);
      setAgentTotalBalanceUsd(typeof payload.totalBalanceUsd === "number" ? payload.totalBalanceUsd : null);
      setAgentSolValueUsd(typeof payload.solValueUsd === "number" ? payload.solValueUsd : null);
      setAgentPortfolioStatus(typeof payload.status === "string" ? payload.status : "Agent wallet synced");
    } catch {
      setAgentPortfolioStatus("Failed to sync agent wallet balances");
    }
  }, [readOnlyPerpsSnapshot.agentWalletAddress, remoteAuthToken]);

  useEffect(() => {
    void refreshAgentWalletPortfolio();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshAgentWalletPortfolio();
    }, WALLET_PORTFOLIO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refreshAgentWalletPortfolio]);

  const displayedWalletAddress = walletBalanceMode === "agent"
    ? agentPortfolioWalletAddress
    : activeWalletAddress;
  const displayedPortfolioStatus = walletBalanceMode === "agent" ? agentPortfolioStatus : portfolioStatus;
  const displayedTotalBalanceUsd = walletBalanceMode === "agent" ? agentTotalBalanceUsd : totalBalanceUsd;
  const displayedSolBalance = walletBalanceMode === "agent" ? agentSolBalance : solBalance;
  const displayedSolValueUsd = walletBalanceMode === "agent" ? agentSolValueUsd : solValueUsd;
  const displayedWalletTokens = walletBalanceMode === "agent" ? agentWalletTokens : walletTokens;

  const refreshSelectedWalletPortfolio = useCallback(() => {
    if (walletBalanceMode === "agent") {
      void refreshAgentWalletPortfolio();
      return;
    }
    void refreshWalletPortfolio();
  }, [refreshAgentWalletPortfolio, refreshWalletPortfolio, walletBalanceMode]);

  const selectedChartMarket =
    trackedMarkets.find((market) => market.id === selectedChartSlotId) ?? trackedMarkets[0];
  const selectedSignalMarket =
    trackedMarkets.find((market) => market.id === receiveSignalsForSlotId) ?? trackedMarkets[0];
  const selectedChartGuideKey = normalizeMarketGuideKey(selectedChartMarket?.pair ?? selectedChartMarket?.tvSymbol);
  const selectedChartPerpsPositions = readOnlyPerpsSnapshot.positions.filter((position) => {
    if (position.source === "mock") return false;
    if (!selectedChartGuideKey) return false;

    return (
      normalizeMarketGuideKey(position.marketSymbol) === selectedChartGuideKey ||
      normalizeMarketGuideKey(position.marketName) === selectedChartGuideKey ||
      normalizeMarketGuideKey(position.marketAddress) === selectedChartGuideKey ||
      normalizeMarketGuideKey(position.custodyAddress) === selectedChartGuideKey
    );
  });
  const selectedChartGuides = useMemo(
    () => buildPositionOverlayGuides(selectedChartPerpsPositions),
    [selectedChartPerpsPositions]
  );
  const selectedChartUnrealizedPnl = useMemo(
    () => summarizePositionOverlayPnl(selectedChartPerpsPositions),
    [selectedChartPerpsPositions]
  );

  const cards = trackedMarkets.map((market) => {
    const points = priceHistory[market.id] ?? [];
    const current = points[points.length - 1]?.v ?? 0;
    const change24h = dayChange24h[market.id] ?? 0;
    return { ...market, current, change24h };
  });
  const selectedChartCard = cards.find((market) => market.id === selectedChartSlotId) ?? cards[0];

  useEffect(() => {
    if (!remoteAuthToken) {
      setPerpsPnlByRole({ primary: null, agent: null });
      return;
    }
    let cancelled = false;
    const role = pnlMode;
    const load = async () => {
      let payload: PerpsPnlPayload;
      try {
        const response = await fetch(`/api/perps/pnl?walletRole=${role}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${remoteAuthToken}` },
        });
        const responsePayload = await response.json() as PerpsPnlPayload & { error?: string };
        if (!response.ok) throw new Error(responsePayload.error ?? `Unable to load ${role} Perps PnL.`);
        payload = responsePayload;
      } catch (error) {
        payload = {
          available: false,
          role,
          message: error instanceof Error ? error.message : `Unable to load ${role} Perps PnL.`,
        };
      }
      if (!cancelled) setPerpsPnlByRole((current) => ({ ...current, [role]: payload }));
    };
    void load();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pnlMode, remoteAuthToken]);

  const selectedPerpsPnl = perpsPnlByRole[pnlMode];
  const displayedPnlTimeline = useMemo(() => {
    const points = (selectedPerpsPnl?.points ?? []).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v));
    return points.length > 0 ? points : [{ t: renderNow, v: 0 }];
  }, [renderNow, selectedPerpsPnl?.points]);

  useEffect(() => {
    if (!remoteAuthToken) {
      setPnlStatus("Connect the Main wallet to load Perps PnL.");
    } else if (!selectedPerpsPnl) {
      setPnlStatus(`Loading ${pnlMode === "primary" ? "Main" : "Agent"} wallet Perps history...`);
    } else if (!selectedPerpsPnl.available) {
      setPnlStatus(selectedPerpsPnl.message ?? `No ${pnlMode === "primary" ? "Main" : "Agent"} wallet Perps history is available.`);
    } else {
      const coverage = selectedPerpsPnl.historyComplete ? "complete available history" : `latest ${selectedPerpsPnl.tradeCount ?? 0} records`;
      setPnlStatus(`Tracking ${pnlMode === "primary" ? "Main" : "Agent"} wallet Jupiter Perps PnL from ${coverage}.`);
    }
  }, [pnlMode, remoteAuthToken, selectedPerpsPnl]);

  const pnlValues = useMemo(() => {
    const now = renderNow;
    const currentDate = renderNow > 0 ? new Date(renderNow) : new Date(0);
    const yearStart = new Date(currentDate.getFullYear(), 0, 1).getTime();

    return {
      d24: calculatePnlSince(displayedPnlTimeline, now - 24 * 60 * 60 * 1000),
      d7: calculatePnlSince(displayedPnlTimeline, now - 7 * 24 * 60 * 60 * 1000),
      d30: calculatePnlSince(displayedPnlTimeline, now - 30 * 24 * 60 * 60 * 1000),
      ytd: calculatePnlSince(displayedPnlTimeline, yearStart),
    };
  }, [displayedPnlTimeline, renderNow]);

  const pnlChartPoints = useMemo(() => {
    const now = renderNow;
    const cutoff = pnlRange === "24h"
      ? now - 24 * 60 * 60 * 1000
      : pnlRange === "7d"
        ? now - 7 * 24 * 60 * 60 * 1000
        : pnlRange === "30d"
          ? now - 30 * 24 * 60 * 60 * 1000
          : new Date((renderNow > 0 ? new Date(renderNow) : new Date(0)).getFullYear(), 0, 1).getTime();

    return pnlPointsForRange(displayedPnlTimeline, cutoff, now);
  }, [displayedPnlTimeline, pnlRange, renderNow]);

  function updateTrackedMarket(slotId: string, nextProduct: string) {
    const option = marketOptions.find((item) => item.coinbaseProduct === nextProduct);
    if (!option) return;
    setTrackedMarkets((prev) =>
      prev.map((market) => (market.id === slotId ? { ...market, ...option } : market))
    );
    setPriceHistory((prev) => ({ ...prev, [slotId]: [] }));
    setDayChange24h((prev) => ({ ...prev, [slotId]: 0 }));
    setLastSignalAt((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
    setSelectedChartSlotId(slotId);
    setReceiveSignalsForSlotId(slotId);
  }

  async function enablePush() {
    if (!pushReady) return;
    if (nativeShell) {
      const { hasLocalNotifications, hasPushNotifications } = getNativePushPluginStatus();
      if (!hasLocalNotifications) {
        setPushStatus("Native notifications plugin missing in this app build");
        return;
      }
      try {
        const localPermission = await LocalNotifications.requestPermissions();
        const pushPermission = hasPushNotifications
          ? await PushNotifications.requestPermissions()
          : { receive: "prompt" as const };
        if (localPermission.display !== "granted") {
          writeNativeAlertsEnabled(false);
          setPushEnabled(false);
          setPushStatus("Native alerts disabled");
          return;
        }
        if (!hasPushNotifications) {
          writeNativeAlertsEnabled(true);
          setNativePushIssue("APNs push is not included in this installed app build yet.");
          setPushEnabled(true);
          setPushStatus("Local native alerts enabled. Reinstall the iPhone app build to add APNs push.");
          return;
        }
        if (pushPermission.receive !== "granted") {
          writeNativeAlertsEnabled(false);
          setPushEnabled(false);
          setPushStatus("Native push disabled");
          return;
        }
        await PushNotifications.register();
        setNativePushIssue(null);
        writeNativeAlertsEnabled(true);
        setPushEnabled(true);
        setPushStatus("Native alerts enabled, registering APNs token...");
      } catch (error) {
        setPushStatus(error instanceof Error ? error.message : "Native alerts could not be enabled");
      }
      return;
    }

    if (!("Notification" in window)) {
      setPushStatus("Notifications not supported");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushEnabled(false);
      setPushStatus("Alerts disabled");
      return;
    }

    const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!publicKey) {
      setPushStatus("Missing VAPID public key");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const activeSubscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      const subscriptionJson = activeSubscription.toJSON();
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...subscriptionJson,
          walletAddress,
          nativeShell: false,
          platform: "web",
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setPushStatus(payload?.error ?? "Push subscribe failed");
        return;
      }

      setSubscription(subscriptionJson);
      setPushEnabled(true);
      setPushStatus("Alerts enabled");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Push subscribe failed");
    }
  }

  async function disablePush() {
    if (nativeShell) {
      writeNativeAlertsEnabled(false);
      setNativePushIssue(null);
      if (nativePushToken) {
        await fetch("/api/push/native/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: nativePushToken }),
        }).catch(() => undefined);
      }
      setNativePushToken(null);
      setPushEnabled(false);
      setPushStatus("Native alerts disabled");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const active = await registration.pushManager.getSubscription();
      const endpoint = active?.endpoint ?? subscription?.endpoint;
      if (active) {
        await active.unsubscribe();
      }
      if (endpoint) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => undefined);
      }
      setSubscription(null);
      setPushEnabled(false);
      setPushStatus("Alerts disabled");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Failed to disable alerts");
    }
  }

  async function togglePush() {
    if (pushEnabled) {
      await disablePush();
      return;
    }
    await enablePush();
  }

  async function sendTestPush() {
    if (nativeShell) {
      if (!pushEnabled) {
        setPushStatus("Enable native alerts first");
        return;
      }
      const { hasPushNotifications } = getNativePushPluginStatus();
      if (!hasPushNotifications) {
        try {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: Date.now() % 2147483000,
              title: "BremLogic",
              body: "Local native notification works. Install the rebuilt iPhone app to test APNs push.",
              sound: NATIVE_NOTIFICATION_SOUNDS.signal,
            },
          ],
        });
          setPushStatus("Local native test alert sent. APNs push requires the rebuilt app binary.");
        } catch (error) {
          setPushStatus(error instanceof Error ? error.message : "Native local test alert failed");
        }
        return;
      }
      if (!nativePushToken) {
        setPushStatus("Waiting for APNs device token");
        return;
      }
      try {
        const response = await fetch("/api/push/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nativeToken: nativePushToken,
            walletAddress,
            sound: NATIVE_NOTIFICATION_SOUNDS.signal,
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setPushStatus(payload?.error ?? "Native push test failed");
          return;
        }
        setPushStatus("Native test push sent");
      } catch (error) {
        setPushStatus(error instanceof Error ? error.message : "Native push test failed");
      }
      return;
    }

    if (!pushEnabled || !subscription) {
      setPushStatus("Enable push first");
      return;
    }

    setPushStatus("Sending test...");
    try {
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription, walletAddress, sound: NATIVE_NOTIFICATION_SOUNDS.signal }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setPushStatus(payload?.error ?? "Push test failed");
        return;
      }
      setPushStatus("Test push sent");
    } catch (_error) {
      setPushStatus("Push test failed");
    }
  }

  async function createInAppWallet() {
    const passwordInput = window.prompt(
      "Set wallet password (4-16 chars). Leave blank to use default 'bremlogic':",
      DEFAULT_WALLET_PASSWORD
    );
    try {
      await wallet.createWallet((passwordInput ?? "").trim() || DEFAULT_WALLET_PASSWORD);
      setRemoteAuthSource("in-app");
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setPortfolioStatus("In-app wallet created");
    } catch (_error) {
      setPortfolioStatus("Wallet creation failed");
    }
  }

  async function importInAppWallet() {
    const secretInput = window.prompt("Paste wallet private key (base58):");
    if (!secretInput) return;
    const passwordInput = window.prompt(
      "Enter wallet password (4-16 chars). Leave blank for default 'bremlogic':",
      DEFAULT_WALLET_PASSWORD
    );
    try {
      await wallet.importWallet(secretInput, (passwordInput ?? "").trim() || DEFAULT_WALLET_PASSWORD);
      setRemoteAuthSource("in-app");
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setPortfolioStatus("In-app wallet imported");
    } catch (_error) {
      setPortfolioStatus("Wallet import failed");
    }
  }

  async function exportInAppWallet() {
    const exported = wallet.exportWallet();
    if (!exported) {
      setPortfolioStatus("No in-app wallet to export");
      return;
    }
    try {
      await navigator.clipboard.writeText(exported);
      setPortfolioStatus("Wallet secret copied to clipboard");
    } catch (_error) {
      setPortfolioStatus("Copy failed - check browser clipboard permissions");
    }
  }

  async function disconnectInAppWallet() {
    await wallet.disconnect();
    if (walletAddress) {
      try {
        window.localStorage.removeItem(remoteTradesAuthStorageKey(walletAddress));
      } catch {
        // ignore storage errors
      }
    }
    if (remoteAuthSource === "in-app") {
      setRemoteAuthSource(phantomAuthAddress ? "phantom" : null);
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
    }
    setShowDepositModal(false);
    setPortfolioStatus("Wallet disconnected and removed from this device");
  }

  async function loginInAppWallet() {
    const passwordInput = window.prompt("Enter wallet password:", DEFAULT_WALLET_PASSWORD);
    if (passwordInput === null) return;
    try {
      await wallet.login((passwordInput ?? "").trim() || DEFAULT_WALLET_PASSWORD);
      setRemoteAuthSource("in-app");
      setRemoteAuthToken(null);
      setRemoteAuthAddress(null);
      setPortfolioStatus("Wallet unlocked");
    } catch (_error) {
      setPortfolioStatus("Wallet login failed");
    }
  }

  async function changeWalletPassword() {
    if (!wallet.connected) {
      setPortfolioStatus("Connect wallet before changing password");
      return;
    }

    const currentPassword = window.prompt("Enter current password:", DEFAULT_WALLET_PASSWORD);
    if (currentPassword === null) return;
    const nextPassword = window.prompt("Enter new password (4-16 chars):");
    if (nextPassword === null) return;
    const confirmText = window.prompt("Type CHANGE to confirm password update:");
    if (confirmText !== "CHANGE") {
      setPortfolioStatus("Password change cancelled");
      return;
    }

    try {
      await wallet.changePassword((currentPassword || DEFAULT_WALLET_PASSWORD).trim(), nextPassword.trim());
      setPortfolioStatus("Wallet password updated");
    } catch (_error) {
      setPortfolioStatus("Password update failed");
    }
  }

  async function copyDepositAddress() {
    if (!wallet.publicKey) return;
    try {
      await navigator.clipboard.writeText(wallet.publicKey.toBase58());
      setPortfolioStatus("Deposit address copied to clipboard");
    } catch (_error) {
      setPortfolioStatus("Address copy failed");
    }
  }

  async function clearRecentTrades() {
    const activeWallet = tradeStorageAddress;
    setRecentTrades([]);
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
    if (remoteAuthToken) {
      await fetch("/api/trades", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${remoteAuthToken}` },
      }).then(async (response) => {
        if (response.ok) {
          setRemoteSyncStatus("Remote trades cleared");
          return;
        }
        if (response.status === 401 && remoteSyncWalletAddress) {
          try {
            window.localStorage.removeItem(remoteTradesAuthStorageKey(remoteSyncWalletAddress));
          } catch {
            // ignore storage errors
          }
          setRemoteAuthToken(null);
          setRemoteAuthAddress(null);
          setRemoteAuthStatus("Remote auth expired. Re-sign to continue syncing.");
        }
      }).catch(() => undefined);
    }
    try {
      window.localStorage.removeItem(tradesStorageKey(activeWallet));
    } catch (_error) {
      // ignore storage errors
    }
  }

  async function clearRecentSignals() {
    setSignals([]);
    setLastSignalAt({});
    try {
      window.localStorage.removeItem(signalsStorageKey(signalStorageAddress));
    } catch {
      // ignore storage errors
    }
    if (remoteAuthToken && remoteAuthAddress === signalStorageAddress) {
      await fetch("/api/signals", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${remoteAuthToken}` },
      }).catch(() => undefined);
    }
  }

  async function handleManualSwapSuccess(result: JupiterTradeRecord) {
    const manualTradeRecord: StoredTradeRecord = {
      id: `manual-${result.txid}-${Date.now()}`,
      txid: result.txid,
      timestamp: Date.now(),
      walletAddress: wallet.publicKey?.toBase58() ?? undefined,
      source: "manual",
      inputMint: result.inputMint,
      outputMint: result.outputMint,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      signalSummary: "Jupiter widget manual swap",
      gasless: false,
    };
    await persistTradeRecord(manualTradeRecord);
    refreshWalletPortfolio().catch(() => undefined);
  }

  function persistAutoTradeSettings(next: AutoTradeSettings) {
    autoTradeSettingsRef.current = next;
    setAutoTradeSettings(next);
    try {
      const configWalletAddress = remoteAuthAddress ?? remoteSyncWalletAddress;
      const storageKey = configWalletAddress
        ? walletAutoTradeSettingsStorageKey(configWalletAddress)
        : AUTO_TRADE_SETTINGS_STORAGE_KEY;
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch (_error) {
      // ignore storage errors
    }
  }

  function updateAutoTradeSlotToken(slotId: string, token: AutoTradeToken) {
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      slots: autoTradeSettings.slots.map((slot) => (slot.id === slotId ? { ...slot, token } : slot)),
    };
    persistAutoTradeSettings(next);
    if (next.activeSlotId === slotId) {
      setAutoTradeStatus(
        `Auto-trade is on (${token}, ${formatAutoTradeAllocationLabel(next)}, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
      );
    }
    if (next.perpsActiveSlotId === slotId) {
      setPerpsAutoTradeStatus(
        `Perps auto-trade is on (${token}, ${formatAutoTradeAllocationLabel(next, "collateral")}, ${next.perpsLeverage}x, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
      );
    }
  }

  function toggleAutoTradeSlot(slotId: string, enabled: boolean) {
    if (enabled && autoTradeSettings.activeSlotId && autoTradeSettings.activeSlotId !== slotId) {
      setShowAutoTradeSelectorWarning(true);
      return;
    }

    const nextActiveSlotId = enabled ? slotId : null;
    const slot = autoTradeSettings.slots.find((item) => item.id === slotId);
    const token = slot ? getAutoTradeTokenOption(slot.token) : null;
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      activeSlotId: nextActiveSlotId,
    };
    persistAutoTradeSettings(next);
    setAutoTradeStatus(
      enabled && token
        ? `Auto-trade is on (${token.symbol}, ${formatAutoTradeAllocationLabel(next)}, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
        : "Auto-trade is off"
    );
  }

  function togglePerpsAutoTradeSlot(slotId: string, enabled: boolean) {
    if (enabled && autoTradeSettings.perpsActiveSlotId && autoTradeSettings.perpsActiveSlotId !== slotId) {
      setShowAutoTradeSelectorWarning(true);
      return;
    }

    const nextPerpsActiveSlotId = enabled ? slotId : null;
    const slot = autoTradeSettings.slots.find((item) => item.id === slotId);
    const token = slot ? getAutoTradeTokenOption(slot.token) : null;
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      perpsActiveSlotId: nextPerpsActiveSlotId,
    };
    persistAutoTradeSettings(next);
    setPerpsAutoTradeStatus(
      enabled && token
        ? `Perps auto-trade is on (${token.symbol}, ${formatAutoTradeAllocationLabel(next, "collateral")}, ${next.perpsLeverage}x, ${next.mode === "buy-only" ? "Buy Only" : "All"})`
        : "Perps auto-trade is off"
    );
  }

  function updateAutoTradeMode(mode: AutoTradeMode) {
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      mode,
    };
    persistAutoTradeSettings(next);
  }

  function toggleDisableTpLock(disabled: boolean) {
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      disableTpLock: disabled,
    };
    if (disabled) {
      setPendingTakeProfit(null);
      pendingTakeProfitRef.current = null;
    }
    persistAutoTradeSettings(next);
  }

  function updatePerpsLeverage(value: number) {
    const perpsLeverage = Number.isFinite(value) ? Math.min(250, Math.max(1, value)) : DEFAULT_AUTO_TRADE_SETTINGS.perpsLeverage;
    const next: AutoTradeSettings = {
      ...autoTradeSettings,
      perpsLeverage,
    };
    persistAutoTradeSettings(next);
  }

  function saveSignalParams() {
    try {
      const configWalletAddress = remoteAuthAddress ?? remoteSyncWalletAddress;
      const paramsKey = configWalletAddress ? walletParamsStorageKey(configWalletAddress) : PARAMS_STORAGE_KEY;
      const settingsKey = configWalletAddress
        ? walletAutoTradeSettingsStorageKey(configWalletAddress)
        : AUTO_TRADE_SETTINGS_STORAGE_KEY;
      window.localStorage.setItem(paramsKey, JSON.stringify(params));
      window.localStorage.setItem(settingsKey, JSON.stringify(autoTradeSettings));
      const alreadySynced = serializeAutomationConfig(autoTradeSettings, params) === syncedAutomationSnapshotRef.current;
      setParamsSaveStatus(
        configWalletAddress && remoteAuthToken
          ? alreadySynced ? "Synced to wallet" : "Saving to wallet..."
          : "Saved on this device"
      );
    } catch (_error) {
      setParamsSaveStatus("Save failed");
    }
  }

  function resetSignalParams() {
    paramsRef.current = DEFAULT_PARAMS;
    autoTradeSettingsRef.current = DEFAULT_AUTO_TRADE_SETTINGS;
    setParams(DEFAULT_PARAMS);
    setAutoTradeSettings(DEFAULT_AUTO_TRADE_SETTINGS);
    setPendingTakeProfit(null);
    pendingTakeProfitRef.current = null;
    setAutoTradeStatus("Auto-trade is off");
    setPerpsAutoTradeStatus("Perps auto-trade is off");
    try {
      window.localStorage.removeItem(PARAMS_STORAGE_KEY);
      window.localStorage.removeItem(AUTO_TRADE_SETTINGS_STORAGE_KEY);
      const configWalletAddress = remoteAuthAddress ?? remoteSyncWalletAddress;
      if (configWalletAddress) {
        window.localStorage.removeItem(walletParamsStorageKey(configWalletAddress));
        window.localStorage.removeItem(walletAutoTradeSettingsStorageKey(configWalletAddress));
      }
    } catch (_error) {
      // ignore storage errors
    }
    setParamsSaveStatus("Reset to defaults");
  }

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as DashboardSectionLayout[];
      if (!Array.isArray(parsed)) return;
      const normalized = DEFAULT_DASHBOARD_LAYOUT.map((defaults) => {
        const existing = parsed.find((item) => item?.id === defaults.id);
        return {
          id: defaults.id,
          width: Number.isFinite(existing?.width) ? Math.max(320, Number(existing?.width)) : defaults.width,
          height: Number.isFinite(existing?.height) ? Math.max(260, Number(existing?.height)) : defaults.height,
        };
      });
      setDashboardLayout(normalized);
    } catch {
      setDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(DASHBOARD_LAYOUT_STORAGE_KEY, JSON.stringify(dashboardLayout));
    } catch {
      // ignore storage errors
    }
  }, [dashboardLayout]);

  useEffect(() => {
    if (!isNativeIosRuntime()) {
      return;
    }

    const nextSignature = JSON.stringify({
      latestSignalSymbol: latestSignal?.symbol ?? null,
      latestSignalSummary: latestSignal?.summary ?? null,
      latestSignalDirection: latestSignal?.direction ?? null,
      latestSignalConfidence:
        typeof latestSignal?.confidence === "number" && Number.isFinite(latestSignal.confidence)
          ? Number(latestSignal.confidence.toFixed(4))
          : null,
      walletBalanceUsd:
        typeof totalBalanceUsd === "number" && Number.isFinite(totalBalanceUsd)
          ? Number(totalBalanceUsd.toFixed(2))
          : null,
      autoTradeStatus,
      perpsAutoTradeStatus,
      perpsSessionState: perpsSessionStateLabel,
      perpsMode: perpsModeLabel,
      perpsExecutionModel: perpsAgentSession?.executionModel ?? "approval-assisted",
    });
    const now = Date.now();
    const recentlySynced = now - lastWidgetSyncAtRef.current < 5 * 60 * 1000;
    if (recentlySynced && nextSignature === lastWidgetSyncSignatureRef.current) {
      return;
    }

    lastWidgetSyncAtRef.current = now;
    lastWidgetSyncSignatureRef.current = nextSignature;

    void syncWidgetSnapshot({
      title: "BremLogic",
      latestSignalSymbol: latestSignal?.symbol ?? null,
      latestSignalSummary: latestSignal?.summary ?? null,
      latestSignalDirection: latestSignal?.direction ?? null,
      latestSignalConfidence:
        typeof latestSignal?.confidence === "number" && Number.isFinite(latestSignal.confidence)
          ? latestSignal.confidence
          : null,
      walletBalanceUsd: typeof totalBalanceUsd === "number" && Number.isFinite(totalBalanceUsd) ? totalBalanceUsd : null,
      autoTradeStatus,
      perpsAutoTradeStatus,
      perpsSessionState: perpsSessionStateLabel,
      perpsMode: perpsModeLabel,
      perpsExecutionModel: perpsAgentSession?.executionModel ?? "approval-assisted",
      updatedAt: (latestSignal?.timestamp ?? Date.now()) / 1000,
      targetURL: "bremlogic://open?target=%2Fsignals-bot%3Ftab%3Dsignals",
    }).catch(() => undefined);
  }, [autoTradeStatus, latestSignal, perpsAgentSession?.executionModel, perpsAutoTradeStatus, perpsModeLabel, perpsSessionStateLabel, totalBalanceUsd]);

  function getSectionLayout(id: DashboardSectionId) {
    return dashboardLayout.find((section) => section.id === id) ??
      DEFAULT_DASHBOARD_LAYOUT.find((section) => section.id === id) ??
      { id, width: 520, height: 400 };
  }

  function reorderDashboardSections(sourceId: DashboardSectionId, targetId: DashboardSectionId) {
    if (sourceId === targetId) return;
    setDashboardLayout((previous) => {
      const next = [...previous];
      const sourceIndex = next.findIndex((section) => section.id === sourceId);
      const targetIndex = next.findIndex((section) => section.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return previous;
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function startResizeSection(id: DashboardSectionId, event: ReactPointerEvent<HTMLButtonElement>) {
    const layout = getSectionLayout(id);
    resizeStateRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: layout.width,
      startHeight: layout.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeSection(event: ReactPointerEvent<HTMLButtonElement>) {
    const state = resizeStateRef.current;
    if (!state) return;
    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    const width = Math.max(320, Math.round(state.startWidth + deltaX));
    const height = Math.max(260, Math.round(state.startHeight + deltaY));
    setDashboardLayout((previous) =>
      previous.map((section) => (section.id === state.id ? { ...section, width, height } : section))
    );
  }

  function stopResizeSection() {
    resizeStateRef.current = null;
  }

  function togglePositionOverlay(enabled: boolean) {
    setPositionOverlayEnabled(enabled);
    try {
      window.localStorage.setItem(POSITION_OVERLAY_STORAGE_KEY, enabled ? "true" : "false");
    } catch {
      // The in-memory setting still applies when local storage is unavailable.
    }
  }

  function toggleScalpOverlay(enabled: boolean) {
    setScalpOverlayEnabled(enabled);
    try {
      window.localStorage.setItem(SCALP_OVERLAY_STORAGE_KEY, enabled ? "true" : "false");
    } catch {
      // The in-memory setting still applies when local storage is unavailable.
    }
  }

  const handleChartTpslModifierChange = useCallback((modifier: JupiterPerpsTpslModifier | null) => {
    chartTpslModifierRef.current = modifier;
  }, []);

  const handleChartGuideModify = useCallback(async (guide: PositionOverlayGuide, triggerPrice: number) => {
    if (!guide.positionId || !guide.kind) throw new Error("This chart level is view-only.");
    const snapshot = readOnlyPerpsSnapshotRef.current;
    const position = snapshot.positions.find((candidate) => candidate.id === guide.positionId);
    if (!position) throw new Error("The open position changed. Refresh the chart and try again.");
    const modifier = chartTpslModifierRef.current;
    if (!modifier) throw new Error("TP/SL editing is still connecting. Try again in a moment.");

    const triggerKind = guide.kind === "tp" ? "take-profit" : "stop-loss";
    const trigger = snapshot.pendingTriggers.find((candidate) => {
      if (candidate.kind !== triggerKind) return false;
      if (position.walletAddress && candidate.walletAddress && position.walletAddress !== candidate.walletAddress) return false;
      if (position.accountRef && candidate.positionPubkey) {
        return position.accountRef === candidate.positionPubkey;
      }
      return (
        position.custodyAddress === candidate.custodyAddress
        && position.collateralCustodyAddress === candidate.collateralCustodyAddress
        && position.side === candidate.side
      );
    });

    await modifier({
      kind: guide.kind,
      position,
      positionRequestPubkey: trigger?.positionRequestPubkey ?? null,
      triggerPrice: triggerPrice.toFixed(6),
    });
  }, []);

  function renderDashboardSection(id: DashboardSectionId) {
    if (id === "chart") {
      return (
        <>
          <div className="tradingview-wrap">
            <TradingViewChart
              symbol={selectedChartMarket?.tvSymbol ?? "COINBASE:SOLUSD"}
              guides={positionOverlayEnabled ? selectedChartGuides : []}
              onModifyGuide={handleChartGuideModify}
              scalpOverlayEnabled={scalpOverlayEnabled}
              scalpOverlayAuthToken={remoteAuthToken}
            />
          </div>
        </>
      );
    }

    if (id === "wallet") {
      return (
        <>
          <div className="wallet-controls">
            {walletBalanceMode === "main" ? (
              <>
                {!wallet.hasWallet ? <button type="button" onClick={createInAppWallet}>Create Wallet</button> : null}
                <button type="button" className="secondary" onClick={importInAppWallet}>Import Wallet</button>
                {wallet.hasWallet ? <button type="button" className="secondary" onClick={exportInAppWallet}>Export Wallet</button> : null}
                {wallet.connected ? <button type="button" onClick={() => setShowDepositModal(true)}>Deposit</button> : null}
                {wallet.hasWallet && !wallet.connected ? <button type="button" onClick={loginInAppWallet}>Login</button> : null}
                {wallet.connected ? <button type="button" className="secondary" onClick={changeWalletPassword}>Change Password</button> : null}
                {wallet.connected ? <button type="button" onClick={disconnectInAppWallet}>Disconnect</button> : null}
              </>
            ) : null}
            <button type="button" className="secondary" onClick={refreshSelectedWalletPortfolio}>
              Refresh {walletBalanceMode === "main" ? "Main" : "Agent"}
            </button>
          </div>
          <div className="subtext" style={{ marginTop: 8 }}>
            {walletBalanceMode === "agent"
              ? "Agent Balance is read only. Trading authority remains in the server-side associated agent wallet."
              : nativeWalletShell && jupiterPerpsController?.connected
                ? "WalletConnect keeps the private key in your wallet. BremLogic requests signatures without importing the key."
                : "Wallet keys are stored in this browser until you disconnect (which removes them from this device)."}
          </div>
          <div className="subtext" style={{ marginTop: 10 }}>
            {displayedWalletAddress
              ? `Address: ${shortAddress(displayedWalletAddress)} · ${walletBalanceMode === "agent" ? "Associated Agent" : activeWalletProviderLabel}`
              : walletBalanceMode === "agent"
                ? "No associated agent wallet is configured."
                : "Create or import an in-app wallet to start tracking balances and queueing trades."}
          </div>
          <div className="subtext" style={{ marginTop: 6 }}>{displayedPortfolioStatus}</div>
          {walletBalanceMode === "main" ? (
            <div className="wallet-trading-panel wallet-trading-panel-swap" style={{ marginTop: 10 }}>
              <JupiterTradePanel
                onTradeSuccess={handleManualSwapSuccess}
                integratedTargetId="bremlogic-manual-swap-widget"
                passthroughWalletContextState={manualSwapPassthroughWalletContextState}
                onRequestConnectWallet={
                  nativeWalletShell
                    ? jupiterPerpsController?.connect
                    : wallet.hasWallet && !wallet.connected
                      ? loginInAppWallet
                      : undefined
                }
              />
            </div>
          ) : null}
          <div className="wallet-holdings">
            <div className="holding-row total-row wallet-balance-total-row">
              <div className="wallet-balance-selector">
                <button
                  type="button"
                  className="wallet-balance-selector-button"
                  aria-haspopup="menu"
                  aria-expanded={walletBalanceMenuOpen}
                  onClick={() => setWalletBalanceMenuOpen((open) => !open)}
                >
                  <span>{walletBalanceMode === "main" ? "Main Balance" : "Agent Balance"}</span>
                  <span aria-hidden="true">{walletBalanceMenuOpen ? "▴" : "▾"}</span>
                </button>
                {walletBalanceMenuOpen ? (
                  <div className="wallet-balance-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className={walletBalanceMode === "main" ? "selected" : ""}
                      onClick={() => {
                        setWalletBalanceMode("main");
                        setWalletBalanceMenuOpen(false);
                      }}
                    >
                      Main Balance
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={walletBalanceMode === "agent" ? "selected" : ""}
                      onClick={() => {
                        setWalletBalanceMode("agent");
                        setWalletBalanceMenuOpen(false);
                      }}
                    >
                      Agent Balance
                    </button>
                  </div>
                ) : null}
              </div>
              <strong>{displayedTotalBalanceUsd === null ? "-" : formatUsd(displayedTotalBalanceUsd)}</strong>
            </div>
            <div className="holding-row token-row">
              <span className="token-meta">
                <Image
                  src="https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png"
                  alt="Solana"
                  className="token-icon"
                  width={20}
                  height={20}
                  unoptimized
                />
                <span className="token-lines">
                  <span className="token-line token-top">Solana</span>
                  <span className="token-line token-bottom">SOL</span>
                </span>
              </span>
              <span className="token-values">
                <span className="token-line token-top">{displayedSolValueUsd === null ? "-" : formatUsd(displayedSolValueUsd)}</span>
                <span className="token-line token-bottom">{displayedSolBalance === null ? "-" : displayedSolBalance.toFixed(4)}</span>
              </span>
            </div>
            {displayedWalletTokens.map((token) => (
              <div key={token.mint} className="holding-row token-row">
                <span className="token-meta">
                  {token.logoURI ? (
                    <Image
                      src={token.logoURI}
                      alt={token.symbol ?? token.name ?? token.mint}
                      className="token-icon"
                      width={20}
                      height={20}
                      unoptimized
                    />
                  ) : null}
                  <span className="token-lines">
                    <span className="token-line token-top">{token.name ?? token.symbol ?? shortAddress(token.mint)}</span>
                    <span className="token-line token-bottom">{shortAddress(token.mint)}</span>
                  </span>
                </span>
                <span className="token-values">
                  <span className="token-line token-top">{token.usdValue !== null && token.usdValue !== undefined ? formatUsd(token.usdValue) : "-"}</span>
                  <span className="token-line token-bottom">{token.amount.toFixed(4)}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      );
    }

    if (id === "perps") {
      return (
        <>
          <PerpsClockCard
            connectionLabel={perpsConnectionLabel}
            sessionStateLabel={perpsSessionStateLabel}
            modeLabel={perpsModeLabel}
            executionModelLabel={perpsAgentSession?.executionModel ?? "approval-assisted"}
            walletControlledLabel={perpsWalletControlNote}
            decisionMode={autoTradeSettings.decisionMode}
            unlimitedSession={perpsAgentSession?.unlimitedSession ?? perpsUnlimitedSession}
            warning={
              perpsAgentSession?.warning
              ?? (perpsModeLabel === "Live mode" && !perpsLiveWalletAllowed
                ? "Live Perps automation is only enabled for approved wallets. Paper mode remains available for this wallet."
                : null)
            }
            canClockIn={
              perpsModeLabel === "Paper mode"
                ? perpsWalletConnected
                : Boolean(jupiterPerpsController?.connected) && perpsLiveWalletAllowed
            }
            isBusy={perpsSessionBusy}
            onClockIn={() => { void clockInPerpsAgent().catch((error: unknown) => setPerpsAutoTradeStatus(error instanceof Error ? error.message : "Clock In failed")); }}
            onClockOut={() => { void clockOutPerpsAgent("User manually clocked out.").catch(() => undefined); }}
            onViewLog={() => { void openDecisionLog(); }}
            scalpModeEnabled={autoTradeSettings.scalpModeEnabled}
            scalpLeverage={SCALP_TRADE_LEVERAGE}
            scalpTakeProfitRoePercent={autoTradeSettings.scalpTakeProfitRoePercent}
            onToggleScalpMode={(enabled) => persistAutoTradeSettings({
              ...autoTradeSettings,
              scalpModeEnabled: enabled,
            })}
            onToggleMode={() => setPerpsSessionModePreference((current) => current === "paper" ? "live" : "paper")}
            onToggleDecisionMode={() => setAutoTradeSettings((current) => ({
              ...current,
              decisionMode: current.decisionMode === "active" ? "shadow" : "active",
            }))}
            onToggleUnlimited={setPerpsUnlimitedSession}
          />
          <PerpsSessionStatus
            walletAddress={remoteSyncWalletAddress ?? jupiterPerpsController?.walletAddress ?? perpsAgentSession?.walletAddress ?? null}
            platformLabel={perpsPlatformLabel}
            providerLabel={perpsProviderLabel}
            appOpen={perpsAgentSession?.appOpen ?? true}
            appForeground={perpsAgentSession?.appForeground ?? (typeof document !== "undefined" ? document.visibilityState === "visible" : true)}
            walletWriteEnabled={perpsAgentSession?.walletWriteEnabled ?? Boolean(jupiterPerpsController?.canWrite)}
            note={perpsAgentSession?.executionModel === "approval-assisted"
              ? "Approval-assisted mode keeps every automated Perps action inside the user's own wallet/session flow."
              : "Agent-wallet mode keeps ownership on the associated agent wallet while syncing positions and controls into this primary-wallet session."}
          />
          <PerpsAgentExecutionFeed executions={perpsAgentExecutions} onClear={clearPerpsAgentExecutions} />
          <JupiterPerpsPositionWidget
            authToken={remoteAuthToken}
            onSnapshotChange={setReadOnlyPerpsSnapshot}
            onControllerChange={setJupiterPerpsController}
            onTpslModifierChange={handleChartTpslModifierChange}
            primaryWalletAddress={remoteAuthAddress ?? remoteSyncWalletAddress ?? walletAddress}
          />
        </>
      );
    }

    if (id === "pnl") {
      return (
        <>
          <div className="subtext" style={{ marginBottom: 10 }}>{pnlStatus}</div>
          {selectedPerpsPnl?.available ? (
            <div className="subtext" style={{ marginBottom: 10 }}>
              Total {formatUsd(selectedPerpsPnl.totalPnlUsd ?? 0)} · Realized {formatUsd(selectedPerpsPnl.realizedPnlUsd ?? 0)} · Open {formatUsd(selectedPerpsPnl.unrealizedPnlUsd ?? 0)} · {selectedPerpsPnl.tradeCount ?? 0} Perps records
            </div>
          ) : null}
          <div className="pnl-metrics">
            <div className="pnl-metric"><span>24hr</span><strong className={pnlValues.d24 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d24)}</strong></div>
            <div className="pnl-metric"><span>7-day</span><strong className={pnlValues.d7 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d7)}</strong></div>
            <div className="pnl-metric"><span>30-day</span><strong className={pnlValues.d30 >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.d30)}</strong></div>
            <div className="pnl-metric"><span>YTD</span><strong className={pnlValues.ytd >= 0 ? "pnl-positive" : "pnl-negative"}>{formatUsd(pnlValues.ytd)}</strong></div>
          </div>
          <div className="wallet-controls" style={{ marginTop: 8 }}>
            <button type="button" className={pnlMode === "primary" ? "" : "secondary"} onClick={() => setPnlMode("primary")}>Main</button>
            <button type="button" className={pnlMode === "agent" ? "" : "secondary"} onClick={() => setPnlMode("agent")}>Agent</button>
          </div>
          <div className="wallet-controls" style={{ marginTop: 8 }}>
            <button type="button" className={pnlRange === "24h" ? "" : "secondary"} onClick={() => setPnlRange("24h")}>24H</button>
            <button type="button" className={pnlRange === "7d" ? "" : "secondary"} onClick={() => setPnlRange("7d")}>7D</button>
            <button type="button" className={pnlRange === "30d" ? "" : "secondary"} onClick={() => setPnlRange("30d")}>30D</button>
            <button type="button" className={pnlRange === "ytd" ? "" : "secondary"} onClick={() => setPnlRange("ytd")}>YTD</button>
          </div>
          <PerpsPnlChart
            points={pnlChartPoints}
            rangeLabel={pnlRange.toUpperCase()}
            walletLabel={pnlMode === "primary" ? "Main" : "Agent"}
          />
        </>
      );
    }

    if (id === "params") {
      return (
        <>
          <div className="controls params-toolbar">
            <div>
              <div className="subtext">{paramsSaveStatus}</div>
              <div className="subtext">Master controls · {automationConfigSyncLabel}</div>
            </div>
            <button type="button" onClick={saveSignalParams}>Save</button>
            <button type="button" className="secondary" onClick={resetSignalParams}>Reset</button>
          </div>
          <div className="controls">
            <label>
              Receive Signals For
              <button type="button" className="secondary" style={{ marginTop: 8 }} onClick={() => setEditingSignalTarget((prev) => !prev)}>
                {selectedSignalMarket?.pair ?? "Select Market"}
              </button>
              {editingSignalTarget ? (
                <select style={{ marginTop: 8 }} value={selectedSignalMarket?.coinbaseProduct ?? ""} onChange={(event) => { updateTrackedMarket(receiveSignalsForSlotId, event.target.value); setEditingSignalTarget(false); }}>
                  {marketOptions.map((option) => (<option key={option.coinbaseProduct} value={option.coinbaseProduct}>{option.pair}</option>))}
                </select>
              ) : null}
            </label>
            <label>Trend window (min)<StepperNumberInput value={params.trendWindow} min={1} max={180} step={1} inputMode="numeric" onChange={(value) => setParams((prev) => ({ ...prev, trendWindow: value }))} /></label>
            <label>Trend threshold %<StepperNumberInput value={params.trendThreshold} min={0.01} max={10} step={0.01} onChange={(value) => setParams((prev) => ({ ...prev, trendThreshold: value }))} /></label>
            <label>Breakout %<StepperNumberInput value={params.breakoutPercent} min={0.01} max={8} step={0.01} onChange={(value) => setParams((prev) => ({ ...prev, breakoutPercent: value }))} /></label>
            <label>Cooldown (sec)<StepperNumberInput value={params.cooldownSeconds} min={5} max={86400} step={300} inputMode="numeric" onChange={(value) => setParams((prev) => ({ ...prev, cooldownSeconds: value }))} /></label>
            <label>
              <span className="allocation-label-row">
                <span>Auto-trade wallet allocation</span>
                <button
                  type="button"
                  className="secondary allocation-mode-button"
                  onClick={() => {
                    const next: AutoTradeSettings = {
                      ...autoTradeSettings,
                      walletAllocationMode: autoTradeSettings.walletAllocationMode === "percent" ? "usd" : "percent",
                    };
                    persistAutoTradeSettings(next);
                  }}
                >
                  {autoTradeSettings.walletAllocationMode === "percent" ? "%" : "$"}
                </button>
              </span>
              <StepperNumberInput
                value={autoTradeSettings.walletPercent}
                min={0.01}
                max={autoTradeSettings.walletAllocationMode === "percent" ? 100 : 1_000_000}
                step={0.01}
                inputMode="decimal"
                onChange={(value) => {
                  const walletPercent = Number.isFinite(value)
                    ? autoTradeSettings.walletAllocationMode === "percent"
                      ? Math.min(100, Math.max(0.01, value))
                      : Math.max(0.01, value)
                    : DEFAULT_AUTO_TRADE_SETTINGS.walletPercent;
                  const next = { ...autoTradeSettings, walletPercent };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              <span className="allocation-label-row">
                <span>Take Profit % or $ (Perps)</span>
                <button
                  type="button"
                  className="secondary allocation-mode-button"
                  onClick={() => {
                    const next: AutoTradeSettings = {
                      ...autoTradeSettings,
                      perpsTakeProfitMode: autoTradeSettings.perpsTakeProfitMode === "percent" ? "usd" : "percent",
                    };
                    persistAutoTradeSettings(next);
                  }}
                >
                  {autoTradeSettings.perpsTakeProfitMode === "percent" ? "%" : "$"}
                </button>
              </span>
              <StepperNumberInput
                value={autoTradeSettings.perpsTakeProfitValue}
                min={0}
                step={0.01}
                onChange={(value) => {
                  const perpsTakeProfitValue = Number.isFinite(value) && value >= 0 ? value : 0;
                  const next = { ...autoTradeSettings, perpsTakeProfitValue };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              <span className="allocation-label-row">
                <span>Take Profit % or $ (Spot)</span>
                <button
                  type="button"
                  className="secondary allocation-mode-button"
                  onClick={() => {
                    const next: AutoTradeSettings = {
                      ...autoTradeSettings,
                      spotTakeProfitMode: autoTradeSettings.spotTakeProfitMode === "percent" ? "usd" : "percent",
                    };
                    persistAutoTradeSettings(next);
                  }}
                >
                  {autoTradeSettings.spotTakeProfitMode === "percent" ? "%" : "$"}
                </button>
              </span>
              <StepperNumberInput
                value={autoTradeSettings.spotTakeProfitValue}
                min={0}
                step={0.01}
                onChange={(value) => {
                  const spotTakeProfitValue = Number.isFinite(value) && value >= 0 ? value : 0;
                  const next = { ...autoTradeSettings, spotTakeProfitValue };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              Stop Loss ROE % (Perps only)
              <StepperNumberInput
                value={autoTradeSettings.stopLossPercent}
                min={OPERATOR_TRAINING_BASELINE.stopLossRoePercent}
                max={OPERATOR_TRAINING_BASELINE.stopLossRoePercent}
                step={0.01}
                onChange={() => {
                  const next = {
                    ...autoTradeSettings,
                    stopLossPercent: OPERATOR_TRAINING_BASELINE.stopLossRoePercent,
                  };
                  persistAutoTradeSettings(next);
                }}
              />
            </label>
            <label>
              Perps leverage
              <StepperNumberInput
                value={autoTradeSettings.perpsLeverage}
                min={1}
                max={250}
                step={0.01}
                onChange={updatePerpsLeverage}
              />
            </label>
            <label>
              Perps trade style
              <select
                value={autoTradeSettings.perpsExecutionMode}
                onChange={(event) => {
                  const perpsExecutionMode: PerpsExecutionMode =
                    event.target.value === "smart-trades" ? "smart-trades" : "set-parameters";
                  const next = { ...autoTradeSettings, perpsExecutionMode };
                  persistAutoTradeSettings(next);
                }}
              >
                <option value="set-parameters">Set Parameter Trades</option>
                <option value="smart-trades">Smart Trades</option>
              </select>
            </label>
            {autoTradeSettings.perpsExecutionMode === "smart-trades" ? (
              <label>
                Smart trade profile
                <select
                  value={autoTradeSettings.smartTradeProfile}
                  onChange={(event) => {
                    const smartTradeProfile: SmartTradeProfile =
                      event.target.value === "conservative" || event.target.value === "aggressive"
                        ? event.target.value
                        : "balanced";
                    const next = { ...autoTradeSettings, smartTradeProfile };
                    persistAutoTradeSettings(next);
                  }}
                >
                  <option value="conservative">Conservative</option>
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                </select>
              </label>
            ) : null}
          </div>
          <div className="auto-trade-selector-wrap">
            <div className="auto-trade-selector-header">
              <strong>Auto-Trade Selector</strong>
              <span className="subtext">Bull signal: buy selected token with USDC. Bear signal: sell selected token to USDC.</span>
              <span className="subtext">
                Perps mode: {autoTradeSettings.perpsExecutionMode === "smart-trades"
                  ? `Smart Trades (${autoTradeSettings.smartTradeProfile}) adjusts collateral, leverage, TP, and SL from confidence and recent volatility.`
                  : "Set Parameter Trades uses the exact wallet %, leverage, TP, and SL values set above."}
              </span>
              {pendingTakeProfit && !autoTradeSettings.disableTpLock ? (
                <span className="subtext">
                  TP lock active: sell {pendingTakeProfit.amount.toFixed(6)} {pendingTakeProfit.tokenSymbol} at {formatUsd(pendingTakeProfit.targetPrice)}
                </span>
              ) : null}
            </div>
            <div className="auto-trade-mode-row">
              <div className="wallet-controls">
                <button
                  type="button"
                  className={autoTradeSettings.mode === "all" ? "" : "secondary"}
                  onClick={() => updateAutoTradeMode("all")}
                >
                  All
                </button>
                <button
                  type="button"
                  className={autoTradeSettings.mode === "buy-only" ? "" : "secondary"}
                  onClick={() => updateAutoTradeMode("buy-only")}
                >
                  Buy Only
                </button>
              </div>
              <label className="auto-trade-checkbox-row">
                <input
                  type="checkbox"
                  checked={autoTradeSettings.disableTpLock}
                  onChange={(event) => toggleDisableTpLock(event.target.checked)}
                />
                <span>Disable TP Lock</span>
              </label>
            </div>
            <div className="auto-trade-selector-grid">
              {autoTradeSettings.slots.map((slot) => (
                <div key={slot.id} className="auto-trade-slot">
                  <label>
                    Token
                    <select value={slot.token} onChange={(event) => updateAutoTradeSlotToken(slot.id, event.target.value as AutoTradeToken)}>
                      {AUTO_TRADE_TOKEN_OPTIONS.map((option) => (<option key={option.symbol} value={option.symbol}>{option.label}</option>))}
                    </select>
                  </label>
                  <label className="auto-trade-slot-toggle">
                    <span className="subtext">Auto-trade</span>
                    <input type="checkbox" checked={autoTradeSettings.activeSlotId === slot.id} onChange={(event) => toggleAutoTradeSlot(slot.id, event.target.checked)} />
                    <span>{autoTradeSettings.activeSlotId === slot.id ? "On" : "Off"}</span>
                  </label>
                  <label className="auto-trade-slot-toggle">
                    <span className="subtext">Perps auto-trade</span>
                    <input type="checkbox" checked={autoTradeSettings.perpsActiveSlotId === slot.id} onChange={(event) => togglePerpsAutoTradeSlot(slot.id, event.target.checked)} />
                    <span>{autoTradeSettings.perpsActiveSlotId === slot.id ? "On" : "Off"}</span>
                  </label>
                </div>
              ))}
            </div>
            {showAutoTradeSelectorWarning ? (
              <div className="auto-trade-selector-modal" role="alertdialog" aria-modal="true">
                <div className="auto-trade-selector-modal-card">
                  <strong>Only One Token Allowed For Each Auto-Trade Mode At A Time</strong>
                  <button type="button" style={{ marginTop: 10 }} onClick={() => setShowAutoTradeSelectorWarning(false)}>OK</button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      );
    }

    if (id === "signals") {
      return (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <button type="button" className="secondary" onClick={clearRecentSignals}>Clear Signals</button>
          </div>
          {signals.length === 0 && <div className="subtext">Waiting for signal triggers.</div>}
          {signals.length > 0 && <div className="subtext">Showing the newest signals for this wallet · {signals.length}/{MAX_SIGNAL_HISTORY}</div>}
          <div className="signals-scroll" style={{ maxHeight: VISIBLE_SIGNAL_ROWS * 80 }}>
            {signals.map((signal) => (
              <div key={signal.id} className={`signal ${signal.direction === "bearish" ? "negative" : ""}`}>
                <div>
                  <div>{signal.symbol} · {signal.type.toUpperCase()}</div>
                  <div className="signal-meta">{signal.summary}</div>
                  <div className="subtext">Signal time: {new Date(signal.timestamp).toLocaleString()}</div>
                </div>
                <div>{Math.round(signal.confidence * 100)}%</div>
              </div>
            ))}
          </div>
        </>
      );
    }

    if (id === "trades") {
      return (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div className="wallet-controls"><button type="button" className="secondary" onClick={clearRecentTrades}>Clear Trades</button></div>
          </div>
          <div className="subtext">Local device view keeps the most recent {LOCAL_RECENT_TRADES_CAP} trades for quick history. Remote sync stores a longer canonical history for cross-device PnL.</div>
          <div className="subtext">Remote status · auth: {remoteAuthStatus} · sync: {remoteSyncStatus}</div>
          {!activeWalletAddress && recentTrades.length === 0 && (<div className="subtext">Connect a wallet for live execution. Auto-trade can still run paper executions.</div>)}
          {recentTrades.length === 0 && activeWalletAddress && (<div className="subtext">No recent trades recorded for this wallet yet.</div>)}
          <div className="recent-trades-scroll">
            {recentTrades.map((trade) => (
              <div key={trade.id} className="news-item">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{trade.source === "auto" ? "Auto trade" : "Manual trade"}</span>
                  <span className="subtext">{new Date(trade.timestamp).toLocaleTimeString()}</span>
                </div>
                {trade.signalSummary ? <div className="subtext">{trade.signalSummary}</div> : null}
                <div className="news-meta">
                  <span>{trade.txid.startsWith("auto-") || trade.txid.startsWith("manual-") ? trade.txid.slice(0, 20) : shortAddress(trade.txid)}</span>
                  {trade.txid.startsWith("auto-") ? (
                    <span>Simulated execution</span>
                  ) : trade.txid.startsWith("manual-") ? (
                    <span>Manual entry</span>
                  ) : (
                    <a href={`https://solscan.io/tx/${trade.txid}`} target="_blank" rel="noreferrer">View Tx</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      );
    }

    return null;
  }

  function renderStructuredPanel(id: DashboardSectionId) {
    return (
      <article key={id} className="panel dashboard-panel dashboard-panel-static">
        <div className="dashboard-panel-toolbar">
          <div className="dashboard-panel-title-group">
            <div className="dashboard-panel-title-row">
              <span className="dashboard-panel-title">{DASHBOARD_SECTION_TITLES[id]}</span>
              {id === "chart" ? (
                <div className="chart-overlay-toggles">
                  <label className="position-overlay-toggle">
                    <span>
                      Position Overlay <strong>{positionOverlayEnabled ? "On" : "Off"}</strong>
                    </span>
                    <span className="perps-scalp-switch">
                      <input
                        type="checkbox"
                        checked={positionOverlayEnabled}
                        onChange={(event) => togglePositionOverlay(event.target.checked)}
                        aria-label="Toggle position overlay"
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
                  <label className="position-overlay-toggle scalp-overlay-toggle">
                    <span>
                      Scalp Agent <strong>{scalpOverlayEnabled ? "On" : "Off"}</strong>
                    </span>
                    <span className="perps-scalp-switch">
                      <input
                        type="checkbox"
                        checked={scalpOverlayEnabled}
                        onChange={(event) => toggleScalpOverlay(event.target.checked)}
                        aria-label="Toggle Scalp Agent overlay"
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
                </div>
              ) : null}
            </div>
            {id === "chart" && selectedChartCard ? (
              <span className="subtext chart-market-summary">
                <span>
                  {selectedChartCard.pair} {formatUsd(selectedChartCard.current)} · 24h {selectedChartCard.change24h >= 0 ? "+" : ""}
                  {selectedChartCard.change24h.toFixed(2)}%
                </span>
                <span
                  className={`chart-unrealized-pnl${selectedChartUnrealizedPnl === null
                    ? ""
                    : selectedChartUnrealizedPnl >= 0
                      ? " pnl-positive"
                      : " pnl-negative"}`}
                >
                  Unrealized PnL {selectedChartUnrealizedPnl === null
                    ? "--"
                    : `${selectedChartUnrealizedPnl >= 0 ? "+" : ""}${formatUsd(selectedChartUnrealizedPnl)}`}
                </span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="dashboard-panel-content">
          {renderDashboardSection(id)}
        </div>
      </article>
    );
  }

  return (
    <main>
      <header>
        <div className="header-row">
          <div className="header-brand-block">
            <Image
              className="brand-logo"
              src="/bremlogic-logo.png"
              alt="BremLogic"
              width={1038}
              height={338}
              priority
            />
            <div className="header-status-layout">
              <div className="header-status-top">
                <div className={`badge badge-status badge-status-agent ${perpsModeLabel === "Paper mode" ? "badge-status-paper" : "badge-status-live"}`}>
                  Perps Agent: {perpsConnectionLabel} · {perpsSessionStateLabel} · {perpsModeLabel}
                </div>
                <div ref={notificationPanelRef} className="notification-bell-wrap">
                  <button
                    type="button"
                    className={`notification-bell-button ${notificationPanelOpen ? "open" : ""}`}
                    aria-expanded={notificationPanelOpen}
                    aria-label="Notification settings"
                    onClick={() => setNotificationPanelOpen((open) => !open)}
                  >
                    <span aria-hidden="true">🔔</span>
                  </button>
                  {notificationPanelOpen ? (
                    <div className="notification-popover panel compact-panel">
                      <strong>Alerts & Push</strong>
                      <span className="subtext">{pushStatus}</span>
                      {activeApprovalStatus ? <span className="subtext">{activeApprovalStatus}</span> : null}
                      <div className="alerts-actions">
                        <button
                          type="button"
                          onClick={togglePush}
                          disabled={!pushReady}
                          className={pushEnabled ? "push-toggle on" : "push-toggle off"}
                        >
                          {pushEnabled ? "Alerts Enabled" : "Alerts Disabled"}
                        </button>
                        <button type="button" className="secondary" onClick={sendTestPush}>Send Test Push</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="header-status-bottom">
                <div className="badge badge-status badge-status-primary badge-status-full">{perpsAutoTradeStatus}</div>
                <div className="badge badge-status badge-status-wide badge-status-full">{autoTradeStatus}</div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="dashboard-layout dashboard-layout-static" style={{ marginBottom: 22 }}>
        <div className="tab-panel" hidden={activeSignalsTab !== "signals"}>
          {renderStructuredPanel("chart")}
          {renderStructuredPanel("params")}
          {renderStructuredPanel("signals")}
        </div>
        <div className="tab-panel" hidden={activeSignalsTab !== "perps"}>
          {renderStructuredPanel("perps")}
        </div>
        <div className="tab-panel" hidden={activeSignalsTab !== "simulator"}>
          {activeSignalsTab === "simulator" ? <EmbeddedSimulatorPanel /> : null}
        </div>
        <div className="tab-panel" hidden={activeSignalsTab !== "wallet"}>
          {activeSignalsTab === "wallet" ? (
            <>
              {renderStructuredPanel("wallet")}
              {renderStructuredPanel("pnl")}
              {renderStructuredPanel("trades")}
            </>
          ) : null}
        </div>
      </section>

      {showDepositModal && wallet.publicKey ? (
        <div className="modal-backdrop" onClick={() => setShowDepositModal(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>Deposit Funds</h3>
            <div className="subtext">Send SOL or SPL tokens to this wallet.</div>
            <Image
              className="deposit-qr"
              src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(wallet.publicKey.toBase58())}`}
              alt="Deposit address QR code"
              width={240}
              height={240}
              unoptimized
            />
            <code className="deposit-address">{wallet.publicKey.toBase58()}</code>
            <div className="wallet-controls">
              <button type="button" onClick={copyDepositAddress}>Copy Address</button>
              <button type="button" className="secondary" onClick={() => setShowDepositModal(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      {decisionLogOpen ? (
        <div className="modal-backdrop" onClick={() => setDecisionLogOpen(false)}>
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              top: "calc(var(--native-content-top-buffer) + 12px)",
              left: "calc(var(--safe-left) + 12px)",
              right: "calc(var(--safe-right) + 12px)",
              bottom: "calc(var(--safe-bottom) + 82px + var(--bottom-bar-fill))",
              width: "auto",
              maxWidth: "none",
              maxHeight: "none",
              margin: 0,
              borderRadius: 20,
              display: "grid",
              gridTemplateRows: "auto 1fr auto",
              overflow: "hidden",
            }}
          >
            <h3>Perps Decision Log</h3>
            <div className="subtext">
              {decisionLogBusy ? "Loading the latest decision-layer journal..." : "Readable audit trail for why the Perps agent scored and accepted or skipped trades."}
            </div>
            <div className="subtext" style={{ marginTop: 6 }}>
              {decisionLearningStatus}
            </div>
            <div style={{
              marginTop: 14,
              minHeight: 0,
              overflow: "auto",
              display: "grid",
              gap: 12,
              paddingRight: 2,
            }}>
              {decisionLogEntries.length > 0 ? decisionLogEntries.map((entry) => {
                const execution = decisionExecutionsById.get(entry.payload.decisionId);
                const wasTaken = execution ? ["submitted", "confirmed", "closed", "paper_executed"].includes(execution.status) : false;
                const wasAttempted = execution?.status === "failed";
                const outcomeLabel = wasTaken
                  ? execution?.status === "closed" ? "TAKEN · CLOSED"
                    : (!entry.recommendation.shouldTrade && entry.recommendation.shadowMode ? "TAKEN · PARAMETER OVERRIDE" : "TAKEN")
                  : wasAttempted ? "ATTEMPT FAILED"
                    : execution?.status === "approval_required" ? "AWAITING APPROVAL"
                      : "SKIPPED";
                const outcomePositive = wasTaken;
                return (
                <article
                  key={entry.payload.decisionId}
                  style={{
                    borderRadius: 14,
                    border: "1px solid var(--border)",
                    background: "rgba(8, 12, 20, 0.92)",
                    padding: 14,
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                        {entry.payload.strategyClass === "scalp" ? "Scalp" : "Smart"} · {entry.payload.symbol} · {entry.payload.direction === "bullish" ? "Long bias" : "Short bias"}
                      </div>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
                        {new Date(entry.payload.createdAt).toLocaleString()} · {shortAddress(entry.payload.walletAddress)} · {entry.payload.sessionMode.toUpperCase()}
                      </div>
                    </div>
                    <div style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      border: `1px solid ${outcomePositive ? "rgba(74, 222, 128, 0.45)" : "rgba(248, 113, 113, 0.45)"}`,
                      background: outcomePositive ? "rgba(22, 101, 52, 0.2)" : "rgba(127, 29, 29, 0.2)",
                      color: outcomePositive ? "#86efac" : "#fca5a5",
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: 0.3,
                    }}>
                      {outcomeLabel} · {Math.round(entry.recommendation.confidenceScore * 100)}%
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                    <div style={{ padding: 10, borderRadius: 12, background: "rgba(15, 23, 42, 0.7)", border: "1px solid rgba(148, 163, 184, 0.16)" }}>
                      <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Requested</div>
                      <div style={{ color: "var(--text)", fontWeight: 700 }}>{formatUsd(entry.payload.requestedTrade.collateralUsd)} · {entry.payload.requestedTrade.leverage.toFixed(2)}x</div>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
                        TP {entry.payload.requestedTrade.takeProfitPrice ? formatUsd(entry.payload.requestedTrade.takeProfitPrice) : "-"} · SL {entry.payload.requestedTrade.stopLossPrice ? formatUsd(entry.payload.requestedTrade.stopLossPrice) : "-"}
                      </div>
                    </div>
                    <div style={{ padding: 10, borderRadius: 12, background: "rgba(15, 23, 42, 0.7)", border: "1px solid rgba(148, 163, 184, 0.16)" }}>
                      <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Recommended</div>
                      <div style={{ color: "var(--text)", fontWeight: 700 }}>{formatUsd(entry.recommendation.recommendedCollateralUsd)} · {entry.recommendation.recommendedLeverage.toFixed(2)}x</div>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
                        TP {entry.recommendation.recommendedTakeProfitPrice ? formatUsd(entry.recommendation.recommendedTakeProfitPrice) : "-"} · SL {entry.recommendation.recommendedStopLossPrice ? formatUsd(entry.recommendation.recommendedStopLossPrice) : "-"}
                      </div>
                    </div>
                    <div style={{ padding: 10, borderRadius: 12, background: "rgba(15, 23, 42, 0.7)", border: "1px solid rgba(148, 163, 184, 0.16)" }}>
                      <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Market</div>
                      <div style={{ color: "var(--text)", fontWeight: 700 }}>
                        {entry.payload.marketContext.spotPrice ? formatUsd(entry.payload.marketContext.spotPrice) : "-"} · {entry.payload.marketContext.trendBias ?? "unknown"}
                      </div>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
                        Vol {entry.payload.marketContext.volatilityPercent?.toFixed(2) ?? "-"}% · Move {entry.payload.marketContext.recentPriceChangePercent?.toFixed(2) ?? "-"}%
                      </div>
                    </div>
                  </div>

                  <div style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.55 }}>
                    {entry.recommendation.explanationSummary}
                  </div>
                  {wasTaken && !entry.recommendation.shouldTrade ? (
                    <div style={{ color: "#fde68a", fontSize: 12 }}>
                      The model would have skipped this setup, but Set Parameters is authoritative and the trade was submitted. The model result remains shadow-only for learning.
                    </div>
                  ) : execution ? (
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>
                      Execution: {execution.status.replace(/_/g, " ")} · {execution.reasonMessage}
                    </div>
                  ) : null}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span style={{
                      padding: "5px 9px",
                      borderRadius: 999,
                      background: "rgba(56, 189, 248, 0.16)",
                      color: "#7dd3fc",
                      fontSize: 11,
                      fontWeight: 700,
                    }}>
                      Risk {entry.recommendation.riskGrade}
                    </span>
                    <span style={{
                      padding: "5px 9px",
                      borderRadius: 999,
                      background: "rgba(250, 204, 21, 0.14)",
                      color: "#fde68a",
                      fontSize: 11,
                      fontWeight: 700,
                    }}>
                      {entry.payload.executionModel}
                    </span>
                    {entry.recommendation.shadowMode ? (
                      <span style={{
                        padding: "5px 9px",
                        borderRadius: 999,
                        background: "rgba(192, 132, 252, 0.14)",
                        color: "#d8b4fe",
                        fontSize: 11,
                        fontWeight: 700,
                      }}>
                        Shadow mode
                      </span>
                    ) : null}
                    {entry.recommendation.explanationTags.map((tag) => (
                      <span
                        key={`${entry.payload.decisionId}-${tag}`}
                        style={{
                          padding: "5px 9px",
                          borderRadius: 999,
                          background: "rgba(148, 163, 184, 0.12)",
                          color: "var(--muted)",
                          fontSize: 11,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </article>
                );
              }) : (
                <div style={{
                  padding: 14,
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  background: "rgba(8, 12, 20, 0.92)",
                  color: "var(--muted)",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}>
                  {decisionLogContent}
                </div>
              )}

              {legacyDecisionExecutions.length > 0 ? (
                <article style={{
                  borderRadius: 14,
                  border: "1px solid var(--border)",
                  background: "rgba(8, 12, 20, 0.92)",
                  padding: 14,
                  display: "grid",
                  gap: 10,
                }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Earlier executions before detailed logging</div>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    These were captured from the execution feed, so they do not include full decision-layer reasoning.
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {legacyDecisionExecutions.slice(0, 8).map((execution) => (
                      <div
                        key={execution.executionId}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 10,
                          flexWrap: "wrap",
                          padding: 10,
                          borderRadius: 12,
                          background: "rgba(15, 23, 42, 0.7)",
                          border: "1px solid rgba(148, 163, 184, 0.16)",
                        }}
                      >
                        <div>
                          <div style={{ color: "var(--text)", fontWeight: 700 }}>
                            {execution.symbol} · {execution.side.toUpperCase()} · {formatUsd(execution.sizeUsd)}
                          </div>
                          <div style={{ color: "var(--muted)", fontSize: 12 }}>
                            {new Date(execution.createdAt).toLocaleString()} · {execution.mode.toUpperCase()} · {execution.executionModel}
                          </div>
                        </div>
                        <div style={{ color: "var(--muted)", fontSize: 12, maxWidth: 320 }}>
                          {execution.reasonMessage}
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ) : null}
            </div>
            <div className="wallet-controls">
              <button type="button" className="secondary" onClick={() => { void openDecisionLog(); }} disabled={decisionLogBusy}>
                {decisionLogBusy ? "Refreshing..." : "Refresh Log"}
              </button>
              <button type="button" onClick={() => setDecisionLogOpen(false)}>Close</button>
              <button type="button" className="secondary" onClick={() => { void trainDecisionAgent(); }} disabled={decisionLearningBusy}>
                {decisionLearningBusy ? "Training..." : "Train Agent"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {aiPanelOpen ? (
        <div style={{
          position: "fixed",
          top: "calc(var(--native-content-top-buffer) + 12px)",
          left: "calc(var(--safe-left) + 12px)",
          right: "calc(var(--safe-right) + 12px)",
          bottom: "calc(var(--safe-bottom) + 82px + var(--bottom-bar-fill))",
          zIndex: 70,
          borderRadius: 20,
          border: "1px solid rgba(94, 234, 212, 0.2)",
          background: "linear-gradient(180deg, rgba(9, 14, 23, 0.98), rgba(7, 11, 18, 0.985))",
          boxShadow: "0 22px 56px rgba(2, 6, 23, 0.5)",
          backdropFilter: "blur(16px)",
          display: "grid",
          gridTemplateRows: "auto auto 1fr auto",
          overflow: "hidden",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "12px 12px 9px",
            borderBottom: "1px solid rgba(148, 163, 184, 0.14)",
          }}>
            <div>
              <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700 }}>BremLogic Ai</div>
              <div style={{ color: "var(--muted)", fontSize: 11, lineHeight: 1.35 }}>{currentAiMarket.symbol} · {currentAiMarket.timeframe}</div>
            </div>
            <button type="button" className="secondary" onClick={() => setAiPanelVisibility(false)} style={{ padding: "8px 12px", fontSize: 12 }}>Close</button>
          </div>

          <div style={{
            display: "flex",
            gap: 7,
            flexWrap: "wrap",
            padding: "9px 12px",
            borderBottom: "1px solid rgba(148, 163, 184, 0.1)",
          }}>
            {[
              "Why did price move like this?",
              "What is the current trend bias?",
              "What levels matter right now?",
            ].map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="secondary"
                onClick={() => { void runAiAnalysis(prompt); }}
                disabled={aiBusy}
                style={{
                  fontSize: 12,
                  padding: "8px 10px",
                  borderRadius: 11,
                  lineHeight: 1.25,
                  flex: "1 1 160px",
                }}
              >
                {prompt}
              </button>
            ))}
          </div>

          <div style={{
            overflow: "auto",
            padding: 12,
            display: "grid",
            gap: 8,
            alignContent: "start",
          }}>
            {aiChatMessages.length === 0 ? (
              <div style={{
                padding: 10,
                borderRadius: 12,
                background: "rgba(15, 23, 42, 0.7)",
                border: "1px solid rgba(148, 163, 184, 0.16)",
                color: "var(--muted)",
                fontSize: 12,
                lineHeight: 1.5,
              }}>
                Ask for a quick read on the current move, trend bias, nearby levels, or how the latest signal lines up with recent price action.
              </div>
            ) : null}
            {aiChatMessages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                style={{
                  justifySelf: message.role === "user" ? "end" : "stretch",
                  maxWidth: message.role === "user" ? "72%" : "100%",
                  padding: "9px 11px",
                  borderRadius: 12,
                  background: message.role === "user" ? "rgba(34, 197, 94, 0.14)" : "rgba(15, 23, 42, 0.82)",
                  border: message.role === "user"
                    ? "1px solid rgba(74, 222, 128, 0.22)"
                    : "1px solid rgba(148, 163, 184, 0.14)",
                  color: "var(--text)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                }}
              >
                {message.content}
              </div>
            ))}
          </div>

          <div style={{
            padding: 12,
            borderTop: "1px solid rgba(148, 163, 184, 0.14)",
            display: "grid",
            gap: 7,
          }}>
            <div style={{ color: "var(--muted)", fontSize: 11 }}>{aiStatus}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
              <textarea
                value={aiPrompt}
                onChange={(event) => setAiPrompt(event.target.value)}
                placeholder="Ask why price moved, what levels matter, or how the latest signal fits."
                rows={3}
                style={{
                  width: "100%",
                  resize: "none",
                  borderRadius: 11,
                  border: "1px solid rgba(148, 163, 184, 0.18)",
                  background: "rgba(15, 23, 42, 0.78)",
                  color: "var(--text)",
                  padding: "9px 11px",
                  fontSize: 16,
                  lineHeight: 1.5,
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitAiPrompt();
                  }
                }}
              />
              <button type="button" onClick={() => { void submitAiPrompt(); }} disabled={aiBusy || !aiPrompt.trim()} style={{ padding: "0 12px", fontSize: 12 }}>
                {aiBusy ? "Thinking..." : "Send"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="footer">
        Signals are informational only and not financial advice. Always verify on-chain details before placing live trades.
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <SolanaWalletProvider>
      <DashboardPage />
    </SolanaWalletProvider>
  );
}
