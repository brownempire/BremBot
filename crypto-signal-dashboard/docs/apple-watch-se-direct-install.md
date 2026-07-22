# BremLogic Apple Watch SE Direct Installation

Use this procedure when the first-generation Apple Watch SE (`Watch5,10`, watchOS 10.6.2) appears in Xcode or `devicectl` as **available (paired)** but not **connected**, and installation fails with:

```text
CoreDeviceError 4000
A connection to this device could not be established.
NSPOSIXErrorDomain Code=60 "Operation timed out"
```

## Confirmed cause

When the paired iPhone is nearby with Bluetooth enabled, the Watch can remain connected through Bluetooth instead of activating its Wi-Fi development endpoint. CoreDevice detects the Watch over Bluetooth, requests a TCP development tunnel, waits for the Watch's Bonjour advertisement, and then times out.

The relevant `remotepairingd` log pattern is:

```text
control channels: [ble-2]
deviceSupportsBTLEBringup=false
attempting to bringup tunnel connectivity over BLE
Received timeout for browsing for on-demand bonjour advert
```

This occurs before watchOS examines the app package, so it is not evidence of an icon, signing, provisioning, architecture, or deployment-target error.

## Working installation procedure

1. Connect the Mac mini, iPhone, and Apple Watch to the same dedicated **2.4 GHz** IoT/development Wi-Fi network.
2. Ensure that the network permits communication between local clients and supports Bonjour/mDNS, multicast, and IPv6. Do not use an isolated guest network.
3. Keep Developer Mode enabled on both the iPhone and Apple Watch.
4. Keep the Watch awake and near the Mac and iPhone.
5. In the iPhone's **Settings** app, turn Bluetooth off. Do not use only the Control Center toggle.
6. Open Control Center on the Watch and confirm that the Wi-Fi icon appears, proving that the Watch is using Wi-Fi directly.
7. Wait for Xcode Device Hub or `xcrun devicectl list devices` to report the Watch as **connected**.
8. Install the Watch app from Xcode or run:

   ```sh
   xcrun devicectl device install app \
     --device B3E6FF6E-B11D-5C66-9211-CE5157AC1187 \
     /path/to/BremLogicWatch.app \
     --timeout 120 \
     --verbose
   ```

9. Verify installation with:

   ```sh
   xcrun devicectl device info apps \
     --device B3E6FF6E-B11D-5C66-9211-CE5157AC1187 \
     --bundle-id com.bremlogic.signalsbot.watchapp \
     --timeout 30
   ```

10. Turn iPhone Bluetooth back on after the installation completes.

## Confirmed working configuration

- Device: Apple Watch SE, first generation (`Watch5,10`)
- watchOS: 10.6.2 (`21U594`)
- Required architecture: `arm64_32`
- BremLogic Watch bundle ID: `com.bremlogic.signalsbot.watchapp`
- Confirmed installed version: 1.0, build 7
- Xcode: 26.6 (`17F113`)

The successful installation occurred immediately after forcing the Watch from the iPhone Bluetooth connection onto the shared 2.4 GHz Wi-Fi network.
