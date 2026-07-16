import AppIntents
import WidgetKit

@available(iOS 17.0, *)
struct BremLogicWidgetRefreshIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh Widget"
    static var description = IntentDescription("Fetch and display the latest BremLogic Perps snapshot.")

    func perform() async throws -> some IntentResult {
        if let snapshot = try? await BremLogicWidgetServerClient.fetch() {
            try? BremLogicWidgetStore.save(snapshot)
        }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
