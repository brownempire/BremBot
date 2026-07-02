import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.bremlogic.signalsbot",
  appName: "BremLogic",
  webDir: "native-shell",
  plugins: {
    LocalNotifications: {
      presentationOptions: ["badge", "sound", "banner", "list"],
    },
  },
  server: {
    url: "https://app.bremlogic.com/signals-bot",
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
