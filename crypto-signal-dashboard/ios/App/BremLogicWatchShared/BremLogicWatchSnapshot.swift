import Foundation

let BremLogicWatchServerURL = URL(string: "https://app.bremlogic.com/api/widget/summary")!

struct BremLogicWatchSnapshot: Codable {
    var openPerpLabel: String?
    var openPerpDetail: String?
    var openPerpPnlUsd: Double?
    var openPerpPnlPercent: Double?
    var openPerpMarket: String?
    var openPerpSide: String?
    var openPerpPositionValueUsd: Double?
    var openPerpCollateralUsd: Double?
    var openPerpEntryPrice: Double?
    var openPerpMarkPrice: Double?
    var openPerpLeverage: Double?
    var openPerpLiquidationPrice: Double?
    var openPerpTakeProfitPrice: Double?
    var openPerpStopLossPrice: Double?
    var openPerpTakeProfitPnlUsd: Double?
    var openPerpStopLossPnlUsd: Double?
    var agentWalletBalanceUsd: Double?
    var walletBalanceUsd: Double?
    var perpsSessionState: String?
    var updatedAt: Double

    static let fallback = BremLogicWatchSnapshot(
        openPerpLabel: "No open perps",
        openPerpDetail: "Agent is monitoring for the next setup.",
        openPerpPnlUsd: nil,
        openPerpPnlPercent: nil,
        openPerpMarket: nil,
        openPerpSide: nil,
        openPerpPositionValueUsd: nil,
        openPerpCollateralUsd: nil,
        openPerpEntryPrice: nil,
        openPerpMarkPrice: nil,
        openPerpLeverage: nil,
        openPerpLiquidationPrice: nil,
        openPerpTakeProfitPrice: nil,
        openPerpStopLossPrice: nil,
        openPerpTakeProfitPnlUsd: nil,
        openPerpStopLossPnlUsd: nil,
        agentWalletBalanceUsd: nil,
        walletBalanceUsd: nil,
        perpsSessionState: "Clocked Out",
        updatedAt: Date().timeIntervalSince1970
    )

    static let previewPosition = BremLogicWatchSnapshot(
        openPerpLabel: "SOL SHORT",
        openPerpDetail: "$1,151.28 position • $25.61 collateral • 45x leverage",
        openPerpPnlUsd: 4.76,
        openPerpPnlPercent: 18.57,
        openPerpMarket: "SOL",
        openPerpSide: "short",
        openPerpPositionValueUsd: 1_151.28,
        openPerpCollateralUsd: 25.61,
        openPerpEntryPrice: 76.85,
        openPerpMarkPrice: 76.44,
        openPerpLeverage: 45,
        openPerpLiquidationPrice: 78.35,
        openPerpTakeProfitPrice: 76.43,
        openPerpStopLossPrice: nil,
        openPerpTakeProfitPnlUsd: 6.34,
        openPerpStopLossPnlUsd: nil,
        agentWalletBalanceUsd: 132.84,
        walletBalanceUsd: 132.84,
        perpsSessionState: "Clocked In",
        updatedAt: Date().timeIntervalSince1970
    )

    var hasOpenPerp: Bool {
        let market = openPerpMarket?.trimmingCharacters(in: .whitespacesAndNewlines)
        return market?.isEmpty == false || openPerpPnlUsd != nil
    }
}

enum BremLogicWatchServerClient {
    static func fetch() async throws -> BremLogicWatchSnapshot {
        var components = URLComponents(url: BremLogicWatchServerURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "widgetRefresh", value: String(Int(Date().timeIntervalSince1970)))
        ]
        var request = URLRequest(url: components?.url ?? BremLogicWatchServerURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-cache, no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(BremLogicWatchSnapshot.self, from: data)
    }
}

func bremLogicSignedUsd(_ value: Double?) -> String {
    guard let value else { return "--" }
    let prefix = value >= 0 ? "+" : "-"
    return "\(prefix)$\(String(format: "%.2f", abs(value)))"
}

func bremLogicWalletUsd(_ value: Double?) -> String {
    guard let value else { return "--" }
    return String(format: "$%.2f", value)
}

func bremLogicPercent(_ value: Double?) -> String {
    guard let value else { return "--" }
    return String(format: "%+.2f%%", value)
}

func bremLogicPrice(_ value: Double?) -> String {
    guard let value else { return "--" }
    if abs(value) >= 1_000 { return String(format: "$%.0f", value) }
    if abs(value) >= 100 { return String(format: "$%.1f", value) }
    return String(format: "$%.2f", value)
}

func bremLogicLeverage(_ value: Double?) -> String {
    guard let value else { return "--" }
    return value.rounded() == value ? String(format: "%.0fx", value) : String(format: "%.1fx", value)
}
