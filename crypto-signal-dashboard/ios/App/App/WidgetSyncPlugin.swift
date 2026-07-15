import Capacitor
import WidgetKit

@objc(WidgetSyncPlugin)
public class WidgetSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    private static var lastReloadAt: Date?
    private let minimumReloadInterval: TimeInterval = 5 * 60

    public let identifier = "WidgetSyncPlugin"
    public let jsName = "WidgetSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reloadTimelines", returnType: CAPPluginReturnPromise)
    ]

    @objc func saveSnapshot(_ call: CAPPluginCall) {
        do {
            let snapshot = try call.decode(BremLogicWidgetSnapshot.self)
            try BremLogicWidgetStore.save(snapshot)
            reloadTimelinesIfNeeded()
            call.resolve(["ok": true])
        } catch {
            call.reject("Unable to save widget snapshot.", nil, error)
        }
    }

    @objc func getSnapshot(_ call: CAPPluginCall) {
        call.resolve(with: BremLogicWidgetStore.load())
    }

    @objc func reloadTimelines(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        Self.lastReloadAt = Date()
        call.resolve(["ok": true])
    }

    private func reloadTimelinesIfNeeded() {
        let now = Date()
        if let lastReloadAt = Self.lastReloadAt, now.timeIntervalSince(lastReloadAt) < minimumReloadInterval {
            return
        }

        WidgetCenter.shared.reloadAllTimelines()
        Self.lastReloadAt = now
    }
}
