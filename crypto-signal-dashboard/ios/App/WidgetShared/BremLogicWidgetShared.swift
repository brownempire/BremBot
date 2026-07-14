import Foundation

let BremLogicWidgetAppGroup = "group.com.bremlogic.signalsbot.shared"
let BremLogicWidgetSnapshotDefaultsKey = "bremlogic.widget.snapshot.v1"

struct BremLogicWidgetSnapshot: Codable {
    var title: String
    var latestSignalSymbol: String?
    var latestSignalSummary: String?
    var latestSignalDirection: String?
    var latestSignalConfidence: Double?
    var walletBalanceUsd: Double?
    var autoTradeStatus: String?
    var perpsAutoTradeStatus: String?
    var updatedAt: Double
    var targetURL: String

    static let fallback = BremLogicWidgetSnapshot(
        title: "BremLogic",
        latestSignalSymbol: nil,
        latestSignalSummary: "Open the app to sync your latest signal snapshot.",
        latestSignalDirection: nil,
        latestSignalConfidence: nil,
        walletBalanceUsd: nil,
        autoTradeStatus: "Auto-trade is off",
        perpsAutoTradeStatus: "Perps auto-trade is off",
        updatedAt: Date().timeIntervalSince1970,
        targetURL: "bremlogic://open?target=%2Fsignals-bot%3Ftab%3Dsignals"
    )
}

enum BremLogicWidgetStore {
    static func sharedDefaults() -> UserDefaults? {
        UserDefaults(suiteName: BremLogicWidgetAppGroup) ?? .standard
    }

    static func load() -> BremLogicWidgetSnapshot {
        guard
            let defaults = sharedDefaults(),
            let data = defaults.data(forKey: BremLogicWidgetSnapshotDefaultsKey),
            let snapshot = try? JSONDecoder().decode(BremLogicWidgetSnapshot.self, from: data)
        else {
            return .fallback
        }

        return snapshot
    }

    static func save(_ snapshot: BremLogicWidgetSnapshot) throws {
        let defaults = sharedDefaults() ?? .standard
        let data = try JSONEncoder().encode(snapshot)
        defaults.set(data, forKey: BremLogicWidgetSnapshotDefaultsKey)
    }
}
