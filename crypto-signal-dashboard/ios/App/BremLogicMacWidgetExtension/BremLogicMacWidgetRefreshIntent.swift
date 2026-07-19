import AppIntents
import WidgetKit

struct BremLogicMacWidgetRefreshIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh BremLogic"
    static var description = IntentDescription("Refreshes BremLogic Perps and wallet data.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
