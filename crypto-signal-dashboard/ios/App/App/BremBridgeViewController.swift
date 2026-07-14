import Capacitor

class BremBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginType(WidgetSyncPlugin.self)
    }
}
