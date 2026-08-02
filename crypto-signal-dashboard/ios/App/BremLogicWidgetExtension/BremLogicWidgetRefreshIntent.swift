import AppIntents
import Foundation
import WidgetKit

@available(iOS 17.0, *)
struct BremLogicWidgetRefreshIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh Widget"
    static var description = IntentDescription("Fetch and display the latest BremLogic Perps snapshot.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        URLCache.shared.removeAllCachedResponses()
        let snapshot = try await BremLogicWidgetServerClient.fetch()
        try BremLogicWidgetStore.save(snapshot)
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
