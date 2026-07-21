import Foundation
import SwiftUI

let BremLogicWidgetAppGroup = "group.com.bremlogic.signalsbot.shared"
let BremLogicWidgetSnapshotDefaultsKey = "bremlogic.widget.snapshot.v1"
let BremLogicWidgetServerURL = URL(string: "https://app.bremlogic.com/api/widget/summary")!

struct BremLogicWidgetCandle: Codable, Identifiable {
    var timestamp: Double
    var open: Double
    var high: Double
    var low: Double
    var close: Double

    var id: Double { timestamp }
}

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
    var chartSymbol: String?
    var chartCandles: [BremLogicWidgetCandle]?
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
        chartSymbol: nil,
        chartCandles: [],
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

struct BremLogicCandlestickChart: View {
    let candles: [BremLogicWidgetCandle]
    let symbol: String?
    let entryPrice: Double?
    let markPrice: Double?
    let takeProfitPrice: Double?
    let liquidationPrice: Double?

    private let upColor = Color(red: 0.035, green: 0.60, blue: 0.51)
    private let downColor = Color(red: 0.95, green: 0.21, blue: 0.27)
    private let gridColor = Color.white.opacity(0.09)
    private let entryColor = Color(red: 0.98, green: 0.75, blue: 0.26)
    private let markColor = Color(red: 0.36, green: 0.68, blue: 0.98)
    private let takeProfitColor = Color(red: 0.57, green: 0.94, blue: 0.78)
    private let liquidationColor = Color(red: 1.0, green: 0.58, blue: 0.22)

    private var visibleCandles: [BremLogicWidgetCandle] {
        Array(candles.sorted { $0.timestamp < $1.timestamp }.suffix(60))
    }

    private func formattedPrice(_ value: Double?) -> String? {
        guard let value, value.isFinite, value > 0 else { return nil }
        return value >= 1_000 ? String(format: "%.0f", value) : String(format: "%.2f", value)
    }

    @ViewBuilder
    private func legendItem(_ label: String, _ price: Double?, color: Color) -> some View {
        if let formatted = formattedPrice(price) {
            HStack(spacing: 2) {
                Circle().fill(color).frame(width: 4, height: 4)
                Text("\(label) \(formatted)")
            }
        }
    }

    var body: some View {
        ZStack {
            Color(red: 0.075, green: 0.09, blue: 0.13)

            if visibleCandles.isEmpty {
                Text("Chart waiting for market data")
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.48))
            } else {
                Canvas { context, size in
                    let plotRect = CGRect(
                        x: 7,
                        y: 20,
                        width: max(1, size.width - 14),
                        height: max(1, size.height - 27)
                    )
                    let candlePrices = visibleCandles.flatMap { [$0.low, $0.high] }
                    let referencePrices = [entryPrice, markPrice, takeProfitPrice, liquidationPrice]
                        .compactMap { $0 }
                        .filter { $0.isFinite && $0 > 0 }
                    guard let rawMinimum = (candlePrices + referencePrices).min(),
                          let rawMaximum = (candlePrices + referencePrices).max()
                    else { return }
                    let rawRange = max(rawMaximum - rawMinimum, rawMaximum * 0.0005)
                    let minimum = rawMinimum - rawRange * 0.08
                    let maximum = rawMaximum + rawRange * 0.08
                    let range = max(maximum - minimum, 0.000_001)

                    func yPosition(_ price: Double) -> CGFloat {
                        plotRect.maxY - CGFloat((price - minimum) / range) * plotRect.height
                    }

                    for index in 0...3 {
                        let y = plotRect.minY + CGFloat(index) * plotRect.height / 3
                        var grid = Path()
                        grid.move(to: CGPoint(x: plotRect.minX, y: y))
                        grid.addLine(to: CGPoint(x: plotRect.maxX, y: y))
                        context.stroke(grid, with: .color(gridColor), lineWidth: 0.55)
                    }
                    for index in 0...4 {
                        let x = plotRect.minX + CGFloat(index) * plotRect.width / 4
                        var grid = Path()
                        grid.move(to: CGPoint(x: x, y: plotRect.minY))
                        grid.addLine(to: CGPoint(x: x, y: plotRect.maxY))
                        context.stroke(grid, with: .color(gridColor.opacity(0.65)), lineWidth: 0.45)
                    }

                    let step = plotRect.width / CGFloat(max(visibleCandles.count, 1))
                    let bodyWidth = max(2, min(8, step * 0.58))
                    for (index, candle) in visibleCandles.enumerated() {
                        let x = plotRect.minX + (CGFloat(index) + 0.5) * step
                        let color = candle.close >= candle.open ? upColor : downColor
                        var wick = Path()
                        wick.move(to: CGPoint(x: x, y: yPosition(candle.high)))
                        wick.addLine(to: CGPoint(x: x, y: yPosition(candle.low)))
                        context.stroke(wick, with: .color(color), lineWidth: 1)

                        let openY = yPosition(candle.open)
                        let closeY = yPosition(candle.close)
                        let bodyTop = min(openY, closeY)
                        let bodyHeight = max(1.5, abs(closeY - openY))
                        var body = Path()
                        body.addRoundedRect(
                            in: CGRect(x: x - bodyWidth / 2, y: bodyTop, width: bodyWidth, height: bodyHeight),
                            cornerSize: CGSize(width: 0.8, height: 0.8)
                        )
                        context.fill(body, with: .color(color))
                    }

                    let levels: [(Double?, Color, [CGFloat])] = [
                        (entryPrice, entryColor, [4, 3]),
                        (markPrice, markColor, []),
                        (takeProfitPrice, takeProfitColor, [2, 3]),
                        (liquidationPrice, liquidationColor, [6, 3]),
                    ]
                    for (price, color, dash) in levels {
                        guard let price, price.isFinite, price > 0 else { continue }
                        let y = yPosition(price)
                        var level = Path()
                        level.move(to: CGPoint(x: plotRect.minX, y: y))
                        level.addLine(to: CGPoint(x: plotRect.maxX, y: y))
                        context.stroke(
                            level,
                            with: .color(color.opacity(0.85)),
                            style: StrokeStyle(lineWidth: 0.8, dash: dash)
                        )
                    }
                }

                VStack(spacing: 0) {
                    HStack(spacing: 7) {
                        Spacer(minLength: 0)
                        legendItem("E", entryPrice, color: entryColor)
                        legendItem("M", markPrice, color: markColor)
                        legendItem("TP", takeProfitPrice, color: takeProfitColor)
                        legendItem("LIQ", liquidationPrice, color: liquidationColor)
                    }
                    .font(.system(size: 7, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                    .padding(.horizontal, 7)
                    .padding(.top, 5)
                    Spacer()
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(symbol ?? "Perpetual") one minute candlestick chart for the last hour")
    }
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
        var components = URLComponents(url: BremLogicWidgetServerURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "widgetRefresh", value: String(Int(Date().timeIntervalSince1970)))
        ]
        var request = URLRequest(url: components?.url ?? BremLogicWidgetServerURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-cache, no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")

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
