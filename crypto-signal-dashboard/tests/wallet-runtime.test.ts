import assert from "node:assert/strict";
import test from "node:test";

import {
  remoteAuthSourceLabel,
  resolvePerpsRuntimePlatform,
  resolveRemoteSyncWalletAddress,
} from "../app/lib/walletRuntime";

test("the native Mac shell reports the Perps runtime as native", () => {
  assert.equal(resolvePerpsRuntimePlatform({ nativeShell: false, nativeMacShell: true, standalonePwa: false }), "native");
  assert.equal(resolvePerpsRuntimePlatform({ nativeShell: false, nativeMacShell: false, standalonePwa: true }), "pwa");
  assert.equal(resolvePerpsRuntimePlatform({ nativeShell: false, nativeMacShell: false, standalonePwa: false }), "web");
});

test("WalletConnect is the remote-sync identity when selected", () => {
  assert.equal(resolveRemoteSyncWalletAddress({
    source: "walletconnect",
    walletConnectAddress: "wallet-connect-address",
    inAppAddress: "in-app-address",
    phantomAddress: "phantom-address",
    remoteAuthAddress: "cached-address",
  }), "wallet-connect-address");
  assert.equal(remoteAuthSourceLabel("walletconnect"), "WalletConnect");
});

test("a cached WalletConnect address survives adapter restoration", () => {
  assert.equal(resolveRemoteSyncWalletAddress({
    source: "walletconnect",
    walletConnectAddress: null,
    inAppAddress: null,
    phantomAddress: null,
    remoteAuthAddress: "cached-address",
  }), "cached-address");
});
