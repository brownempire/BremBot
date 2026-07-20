export type RemoteAuthSource = "in-app" | "phantom" | "walletconnect";

export function resolvePerpsRuntimePlatform(options: {
  nativeShell: boolean;
  nativeMacShell: boolean;
  standalonePwa: boolean;
}) {
  if (options.nativeShell || options.nativeMacShell) return "native" as const;
  if (options.standalonePwa) return "pwa" as const;
  return "web" as const;
}

export function resolveRemoteSyncWalletAddress(options: {
  source: RemoteAuthSource | null;
  walletConnectAddress: string | null;
  inAppAddress: string | null;
  phantomAddress: string | null;
  remoteAuthAddress: string | null;
}) {
  if (options.source === "walletconnect") {
    return options.walletConnectAddress ?? options.remoteAuthAddress;
  }
  if (options.source === "phantom") {
    return options.phantomAddress ?? options.remoteAuthAddress;
  }
  if (options.source === "in-app") {
    return options.inAppAddress ?? options.remoteAuthAddress;
  }
  return null;
}

export function remoteAuthSourceLabel(source: RemoteAuthSource) {
  if (source === "walletconnect") return "WalletConnect";
  if (source === "phantom") return "Phantom";
  return "in-app wallet";
}
