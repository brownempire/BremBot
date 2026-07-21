import AppIntents
import Foundation
import WidgetKit

enum BremLogicMacWidgetIdentity {
    static let kind = "BremLogicMacWidgetHourlyV2"
}

struct BremLogicMacWidgetRefreshIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh BremLogic"
    static var description = IntentDescription("Refreshes BremLogic Perps and wallet data.")
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        URLCache.shared.removeAllCachedResponses()
        if let snapshot = try? await BremLogicWidgetServerClient.fetch() {
            try? BremLogicWidgetStore.save(snapshot)
        }
        WidgetCenter.shared.reloadTimelines(ofKind: BremLogicMacWidgetIdentity.kind)
        return .result()
    }
}
