import Foundation

let BremLogicWidgetAppGroup = "group.com.bremlogic.signalsbot.shared"
let BremLogicWidgetSnapshotDefaultsKey = "bremlogic.widget.snapshot.v1"
let BremLogicWidgetServerURL = URL(string: "https://app.bremlogic.com/api/widget/summary")!

struct BremLogicWidgetSnapshot: Codable {
    var title: String
    var latestSignalSymbol: String?
    var latestSignalSummary: String?
    var latestSignalDirection: String?
    var latestSignalConfidence: Double?
    var openPerpLabel: String?
    var openPerpDetail: String?
    var openPerpPnlUsd: Double?
    var openPerpPnlPercent: Double?
    var walletBalanceUsd: Double?
    var mainWalletBalanceUsd: Double?
    var agentWalletBalanceUsd: Double?
    var autoTradeStatus: String?
    var perpsAutoTradeStatus: String?
    var perpsSessionState: String?
    var perpsMode: String?
    var perpsExecutionModel: String?
    var updatedAt: Double
    var targetURL: String

    static let fallback = BremLogicWidgetSnapshot(
        title: "BremLogic",
        latestSignalSymbol: nil,
        latestSignalSummary: "Open the app to sync your latest signal snapshot.",
        latestSignalDirection: nil,
        latestSignalConfidence: nil,
        openPerpLabel: "Open Perps",
        openPerpDetail: "No open perps",
        openPerpPnlUsd: nil,
        openPerpPnlPercent: nil,
        walletBalanceUsd: nil,
        mainWalletBalanceUsd: nil,
        agentWalletBalanceUsd: nil,
        autoTradeStatus: "Auto-trade is off",
        perpsAutoTradeStatus: "Perps auto-trade is off",
        perpsSessionState: "Clocked Out",
        perpsMode: "Paper mode",
        perpsExecutionModel: "approval-assisted",
        updatedAt: Date().timeIntervalSince1970,
        targetURL: "bremlogic://open?target=%2Fsignals-bot%3Ftab%3Dsignals"
    )
}

enum BremLogicWidgetStore {
    static func load() -> BremLogicWidgetSnapshot {
        let defaultsCandidates = [
            UserDefaults(suiteName: BremLogicWidgetAppGroup),
            UserDefaults.standard,
        ].compactMap { $0 }

        for defaults in defaultsCandidates {
            guard
                let data = defaults.data(forKey: BremLogicWidgetSnapshotDefaultsKey),
                let snapshot = try? JSONDecoder().decode(BremLogicWidgetSnapshot.self, from: data)
            else {
                continue
            }

            return snapshot
        }

        return .fallback
    }

    static func save(_ snapshot: BremLogicWidgetSnapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        UserDefaults(suiteName: BremLogicWidgetAppGroup)?.set(
            data,
            forKey: BremLogicWidgetSnapshotDefaultsKey
        )
        UserDefaults.standard.set(data, forKey: BremLogicWidgetSnapshotDefaultsKey)
    }
}

enum BremLogicWidgetServerError: Error {
    case invalidResponse
    case unsuccessfulStatus(Int)
}

enum BremLogicWidgetServerClient {
    static func fetch() async throws -> BremLogicWidgetSnapshot {
        var request = URLRequest(url: BremLogicWidgetServerURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadRevalidatingCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw BremLogicWidgetServerError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw BremLogicWidgetServerError.unsuccessfulStatus(httpResponse.statusCode)
        }

        return try JSONDecoder().decode(BremLogicWidgetSnapshot.self, from: data)
    }
}
