import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.bremlogic.signalsbot",
  appName: "BremLogic",
  webDir: "native-shell",
  appendUserAgent: " BremLogicNative",
  plugins: {
    LocalNotifications: {
      presentationOptions: ["badge", "sound", "banner", "list"],
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "banner", "list"],
    },
    StatusBar: {
      overlaysWebView: false,
      style: "DARK",
    },
  },
  server: {
    url: "https://app.bremlogic.com/signals-bot?nativeShell=ios&tab=signals",
    cleartext: false,
    allowNavigation: [
      "app.bremlogic.com",
      "www.bremlogic.com",
      "phantom.app",
      "*.phantom.app",
      "jup.ag",
      "*.jup.ag",
    ],
  },
};

export default config;
