import SwiftUI
import WidgetKit

struct BremLogicWatchEntry: TimelineEntry {
    let date: Date
    let snapshot: BremLogicWatchSnapshot
}

struct BremLogicWatchProvider: TimelineProvider {
    private static let cacheKey = "BremLogicWatchWidgetSnapshot"
    private static let lastRefreshReloadKey = "BremLogicWatchWidgetLastRefreshReload"

    private func cachedSnapshot() -> BremLogicWatchSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: Self.cacheKey) else { return nil }
        return try? JSONDecoder().decode(BremLogicWatchSnapshot.self, from: data)
    }

    private func cache(_ snapshot: BremLogicWatchSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: Self.cacheKey)
    }

    private func refreshCache() {
        Task {
            guard let snapshot = try? await BremLogicWatchServerClient.fetch(timeoutInterval: 8) else { return }
            cache(snapshot)

            // The first timeline must remain synchronous so watchOS always has
            // a complication to draw. Request one follow-up timeline after the
            // network value arrives, then throttle it to avoid a reload loop.
            let now = Date()
            let interval = BremLogicWatchRefreshPolicy.interval(for: snapshot)
            let minimumReloadInterval = max(15, interval * 0.8)
            let lastReload = UserDefaults.standard.object(forKey: Self.lastRefreshReloadKey) as? Date
            if let lastReload, now.timeIntervalSince(lastReload) < minimumReloadInterval { return }

            UserDefaults.standard.set(now, forKey: Self.lastRefreshReloadKey)
            WidgetCenter.shared.reloadTimelines(ofKind: "BremLogicWatchWidget")
            WidgetCenter.shared.reloadTimelines(ofKind: "BremLogicWalletWatchWidget")
            WidgetCenter.shared.reloadTimelines(ofKind: "BremLogicAgentWatchWidget")
        }
    }

    func placeholder(in context: Context) -> BremLogicWatchEntry {
        BremLogicWatchEntry(date: Date(), snapshot: .fallback)
    }

    func getSnapshot(in context: Context, completion: @escaping (BremLogicWatchEntry) -> Void) {
        guard !context.isPreview else {
            completion(BremLogicWatchEntry(date: Date(), snapshot: .previewPosition))
            return
        }
        completion(BremLogicWatchEntry(date: Date(), snapshot: cachedSnapshot() ?? .fallback))
        refreshCache()
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BremLogicWatchEntry>) -> Void) {
        let snapshot = cachedSnapshot() ?? .fallback
        let refreshInterval = BremLogicWatchRefreshPolicy.interval(for: snapshot)
        completion(Timeline(
            entries: [BremLogicWatchEntry(date: Date(), snapshot: snapshot)],
            policy: .after(Date().addingTimeInterval(refreshInterval))
        ))
        refreshCache()
    }
}

struct BremLogicComplicationBrand: View {
    var compact = false

    var body: some View {
        Text("BREM")
            .font(.system(size: compact ? 7 : 9, weight: .black, design: .rounded))
            .foregroundStyle(.primary)
            .lineLimit(1)
    }
}

private struct BremLogicRectangularCandlestickChart: View {
    let candles: [BremLogicWatchCandle]
    let entryPrice: Double?
    let entryTimestamp: Double?
    let markPrice: Double?
    let takeProfitPrice: Double?
    let stopLossPrice: Double?

    private let upColor = Color(red: 0.24, green: 0.92, blue: 0.66)
    private let downColor = Color(red: 1.0, green: 0.36, blue: 0.42)
    private let entryColor = Color(red: 1.0, green: 0.72, blue: 0.24)
    private let markColor = Color(red: 0.36, green: 0.68, blue: 0.98)
    private let takeProfitColor = Color(red: 0.30, green: 0.89, blue: 0.54)
    private let stopLossColor = Color(red: 1.0, green: 0.45, blue: 0.45)

    private var visibleCandles: [BremLogicWatchCandle] {
        Array(candles.sorted { $0.timestamp < $1.timestamp }.suffix(32))
    }

    private var visibleEntryCandleIndex: Int? {
        bremLogicWatchEntryCandleIndex(
            candles: visibleCandles,
            entryTimestamp: entryTimestamp
        )
    }

    var body: some View {
        Canvas { context, size in
            guard !visibleCandles.isEmpty else { return }

            let plot = CGRect(x: 1, y: 1, width: max(1, size.width - 2), height: max(1, size.height - 2))
            let candlePrices = visibleCandles.flatMap { [$0.low, $0.high] }
            let levels = [entryPrice, markPrice, takeProfitPrice, stopLossPrice]
                .compactMap { $0 }
                .filter { $0.isFinite && $0 > 0 }
            guard let rawMin = (candlePrices + levels).min(),
                  let rawMax = (candlePrices + levels).max()
            else { return }

            let rawRange = max(rawMax - rawMin, rawMax * 0.0005)
            let minimum = rawMin - rawRange * 0.06
            let maximum = rawMax + rawRange * 0.06
            let range = max(maximum - minimum, 0.000_001)

            func y(_ price: Double) -> CGFloat {
                plot.maxY - CGFloat((price - minimum) / range) * plot.height
            }

            let referenceLines: [(Double?, Color, [CGFloat])] = [
                (entryPrice, entryColor, [3, 2]),
                (markPrice, markColor, []),
                (takeProfitPrice, takeProfitColor, [2, 2]),
                (stopLossPrice, stopLossColor, [2, 2]),
            ]
            for (price, color, dash) in referenceLines {
                guard let price, price.isFinite, price > 0 else { continue }
                var line = Path()
                line.move(to: CGPoint(x: plot.minX, y: y(price)))
                line.addLine(to: CGPoint(x: plot.maxX, y: y(price)))
                context.stroke(
                    line,
                    with: .color(color.opacity(0.8)),
                    style: StrokeStyle(lineWidth: 0.65, dash: dash)
                )
            }

            let step = plot.width / CGFloat(visibleCandles.count)
            let bodyWidth = max(1, min(2.5, step * 0.62))
            for (index, candle) in visibleCandles.enumerated() {
                let x = plot.minX + (CGFloat(index) + 0.5) * step
                let color = candle.close >= candle.open ? upColor : downColor
                var wick = Path()
                wick.move(to: CGPoint(x: x, y: y(candle.high)))
                wick.addLine(to: CGPoint(x: x, y: y(candle.low)))
                context.stroke(wick, with: .color(color), lineWidth: 0.55)

                let openY = y(candle.open)
                let closeY = y(candle.close)
                var body = Path()
                body.addRect(CGRect(
                    x: x - bodyWidth / 2,
                    y: min(openY, closeY),
                    width: bodyWidth,
                    height: max(0.8, abs(closeY - openY))
                ))
                context.fill(body, with: .color(color))
            }

            if let entryPrice,
               entryPrice.isFinite,
               entryPrice > 0,
               let entryIndex = visibleEntryCandleIndex {
                let x = plot.minX + (CGFloat(entryIndex) + 0.5) * step
                let center = CGPoint(x: x, y: y(entryPrice))
                let markerSize = max(4.5, min(7, step * 1.5))
                var marker = Path()
                marker.addEllipse(in: CGRect(
                    x: center.x - markerSize / 2,
                    y: center.y - markerSize / 2,
                    width: markerSize,
                    height: markerSize
                ))
                context.fill(marker, with: .color(.black.opacity(0.72)))
                context.stroke(marker, with: .color(entryColor), lineWidth: 1.25)
            }
        }
        .accessibilityHidden(true)
    }
}

struct BremLogicPositionComplicationView: View {
    let entry: BremLogicWatchEntry
    @Environment(\.widgetFamily) private var family

    private var snapshot: BremLogicWatchSnapshot { entry.snapshot }
    private var market: String { snapshot.openPerpMarket ?? "PERPS" }
    private var chartMarket: String { snapshot.chartSymbol ?? snapshot.openPerpMarket ?? "SOL" }
    private var pnl: String { bremLogicSignedUsd(snapshot.openPerpPnlUsd) }
    private var pnlColor: Color {
        guard let value = snapshot.openPerpPnlUsd else { return .secondary }
        return value >= 0 ? Color(red: 0.45, green: 0.92, blue: 0.62) : Color(red: 1, green: 0.45, blue: 0.45)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    BremLogicComplicationBrand(compact: true)
                    Text(market)
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .lineLimit(1)
                    Text(pnl)
                        .font(.system(size: 11, weight: .black, design: .rounded))
                        .foregroundStyle(pnlColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                }
            }
        case .accessoryCorner:
            Text(pnl)
                .font(.system(size: 13, weight: .black, design: .rounded))
                .foregroundStyle(pnlColor)
                .widgetLabel { Text("B \(market)") }
        case .accessoryInline:
            Text("B \(snapshot.openPerpLabel ?? market) \(pnl) SL \(bremLogicPrice(snapshot.openPerpStopLossPrice))")
        default:
            VStack(alignment: .leading, spacing: 1.5) {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(snapshot.hasOpenPerp ? (snapshot.openPerpLabel ?? market) : "\(chartMarket) MONITORING")
                        .font(.system(size: 9, weight: .black, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                    Spacer(minLength: 2)
                    Text(snapshot.hasOpenPerp ? pnl : bremLogicWalletUsd(snapshot.agentWalletBalanceUsd ?? snapshot.walletBalanceUsd))
                        .font(.system(size: 8.5, weight: .black, design: .rounded))
                        .foregroundStyle(snapshot.hasOpenPerp ? pnlColor : .secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                }

                if let candles = snapshot.chartCandles, !candles.isEmpty {
                    BremLogicRectangularCandlestickChart(
                        candles: candles,
                        entryPrice: snapshot.hasOpenPerp ? snapshot.openPerpEntryPrice : nil,
                        entryTimestamp: snapshot.hasOpenPerp ? snapshot.openPerpEntryTimestamp : nil,
                        markPrice: snapshot.openPerpMarkPrice,
                        takeProfitPrice: snapshot.hasOpenPerp ? snapshot.openPerpTakeProfitPrice : nil,
                        stopLossPrice: snapshot.hasOpenPerp ? snapshot.openPerpStopLossPrice : nil
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .layoutPriority(1)
                } else {
                    Text("Chart waiting for market data")
                        .font(.system(size: 7, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }

                HStack(spacing: 3) {
                    Text("M \(bremLogicPrice(snapshot.openPerpMarkPrice))")
                    if snapshot.hasOpenPerp {
                        Text("TP \(bremLogicPrice(snapshot.openPerpTakeProfitPrice))")
                            .foregroundStyle(.green)
                        Text("SL \(bremLogicPrice(snapshot.openPerpStopLossPrice))")
                            .foregroundStyle(.red)
                    } else {
                        Spacer(minLength: 2)
                        Circle()
                            .fill(snapshot.perpsSessionState == "Clocked In" ? Color.green : Color.secondary)
                            .frame(width: 3.5, height: 3.5)
                        Text(snapshot.perpsSessionState == "Clocked In" ? "LIVE" : "IDLE")
                    }
                }
                .font(.system(size: 6.5, weight: .bold, design: .rounded))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.55)
            }
        }
    }

    var body: some View {
        content
            .containerBackground(.clear, for: .widget)
    }
}

struct BremLogicWalletComplicationView: View {
    let entry: BremLogicWatchEntry
    @Environment(\.widgetFamily) private var family
    private var balance: String { bremLogicWalletUsd(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd) }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Text("B Agent Wallet \(balance)")
            case .accessoryCorner:
                Text(balance).font(.system(size: 12, weight: .black, design: .rounded)).widgetLabel { Text("B WALLET") }
            default:
                ZStack {
                    AccessoryWidgetBackground()
                    VStack(spacing: 1) {
                        BremLogicComplicationBrand(compact: true)
                        Text(balance)
                            .font(.system(size: 10, weight: .black, design: .rounded))
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                        Text("WALLET").font(.system(size: 6, weight: .bold, design: .rounded)).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .containerBackground(.clear, for: .widget)
    }
}

struct BremLogicPnlComplicationView: View {
    let entry: BremLogicWatchEntry
    @Environment(\.widgetFamily) private var family
    private var snapshot: BremLogicWatchSnapshot { entry.snapshot }
    private var pnl: String { bremLogicSignedUsd(snapshot.openPerpPnlUsd) }
    private var pnlPercent: String { bremLogicPercent(snapshot.openPerpPnlPercent) }
    private var pnlColor: Color {
        guard let value = snapshot.openPerpPnlUsd else { return .secondary }
        return value >= 0
            ? Color(red: 0.45, green: 0.92, blue: 0.62)
            : Color(red: 1, green: 0.45, blue: 0.45)
    }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                if snapshot.hasOpenPerp {
                    Text("B PnL \(pnl) \(pnlPercent)")
                } else {
                    Text("B PnL No open position")
                }
            case .accessoryCorner:
                Text(snapshot.hasOpenPerp ? pnl : "--")
                    .font(.system(size: 12, weight: .black, design: .rounded))
                    .foregroundStyle(pnlColor)
                    .minimumScaleFactor(0.5)
                    .widgetLabel { Text("B PNL") }
            default:
                ZStack {
                    AccessoryWidgetBackground()
                    VStack(spacing: 0) {
                        Text("PNL")
                            .font(.system(size: 6, weight: .bold, design: .rounded))
                            .foregroundStyle(.secondary)
                        Text(snapshot.hasOpenPerp ? pnl : "--")
                            .font(.system(size: 11, weight: .black, design: .rounded))
                            .foregroundStyle(pnlColor)
                            .lineLimit(1)
                            .minimumScaleFactor(0.42)
                        Text(snapshot.hasOpenPerp ? pnlPercent : "NO TRADE")
                            .font(.system(size: 6.5, weight: .bold, design: .rounded))
                            .foregroundStyle(snapshot.hasOpenPerp ? pnlColor : .secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.65)
                    }
                }
            }
        }
        .containerBackground(.clear, for: .widget)
    }
}

struct BremLogicWatchWidget: Widget {
    let kind = "BremLogicWatchWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWatchProvider()) { entry in
            BremLogicPositionComplicationView(entry: entry)
        }
        .configurationDisplayName("BremLogic Position")
        .description("Dense open-position status with P/L, leverage, TP, SL, and BremLogic branding.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}

struct BremLogicWalletWatchWidget: Widget {
    let kind = "BremLogicWalletWatchWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWatchProvider()) { entry in
            BremLogicWalletComplicationView(entry: entry)
        }
        .configurationDisplayName("BremLogic Wallet")
        .description("Agent wallet equity at a glance.")
        .supportedFamilies([.accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}

struct BremLogicAgentWatchWidget: Widget {
    // Preserve the original kind so an Agent complication already placed on a
    // watch face is upgraded to PnL without requiring the user to add it again.
    let kind = "BremLogicAgentWatchWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWatchProvider()) { entry in
            BremLogicPnlComplicationView(entry: entry)
        }
        .configurationDisplayName("BremLogic PnL")
        .description("Live unrealized position PnL in dollars and percent.")
        .supportedFamilies([.accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}
