import Foundation

let BremLogicWatchServerURL = URL(string: "https://app.bremlogic.com/api/widget/summary")!

struct BremLogicWatchSnapshot: Codable {
    var openPerpLabel: String?
    var openPerpPnlUsd: Double?
    var openPerpPnlPercent: Double?
    var openPerpMarket: String?
    var openPerpTakeProfitPnlUsd: Double?
    var openPerpStopLossPnlUsd: Double?
    var agentWalletBalanceUsd: Double?
    var walletBalanceUsd: Double?
    var perpsSessionState: String?
    var updatedAt: Double

    static let fallback = BremLogicWatchSnapshot(
        openPerpLabel: "No open perps",
        openPerpPnlUsd: nil,
        openPerpPnlPercent: nil,
        openPerpMarket: nil,
        openPerpTakeProfitPnlUsd: nil,
        openPerpStopLossPnlUsd: nil,
        agentWalletBalanceUsd: nil,
        walletBalanceUsd: nil,
        perpsSessionState: "Clocked Out",
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
