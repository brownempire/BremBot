import Capacitor
import WidgetKit

@objc(WidgetSyncPlugin)
public class WidgetSyncPlugin: CAPPlugin, CAPBridgedPlugin {
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
            WidgetCenter.shared.reloadAllTimelines()
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
        call.resolve(["ok": true])
    }
}
