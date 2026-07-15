import AppIntents
import WidgetKit

@available(iOS 17.0, *)
struct BremLogicWidgetRefreshIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh Widget"
    static var description = IntentDescription("Reload the BremLogic widget using the latest shared snapshot.")

    func perform() async throws -> some IntentResult {
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
