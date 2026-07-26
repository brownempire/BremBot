import SwiftUI
import UIKit
import WidgetKit
#if canImport(ActivityKit)
import ActivityKit
#endif

struct BremLogicWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: BremLogicWidgetSnapshot
}

struct BremLogicWidgetProvider: TimelineProvider {
    private func refreshInterval(for snapshot: BremLogicWidgetSnapshot) -> TimeInterval {
        let market = snapshot.openPerpMarket?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasOpenPerp = market?.isEmpty == false
            || snapshot.openPerpPositionValueUsd != nil
            || snapshot.openPerpPnlUsd != nil
        return hasOpenPerp ? BremLogicOpenPositionRefreshInterval : 15 * 60
    }

    func placeholder(in context: Context) -> BremLogicWidgetEntry {
        BremLogicWidgetEntry(date: Date(), snapshot: .fallback)
    }

    func getSnapshot(in context: Context, completion: @escaping (BremLogicWidgetEntry) -> Void) {
        guard !context.isPreview else {
            completion(BremLogicWidgetEntry(date: Date(), snapshot: .fallback))
            return
        }

        Task {
            let snapshot: BremLogicWidgetSnapshot
            do {
                snapshot = try await BremLogicWidgetServerClient.fetch()
                try? BremLogicWidgetStore.save(snapshot)
            } catch {
                snapshot = BremLogicWidgetStore.load()
            }
            completion(BremLogicWidgetEntry(date: Date(), snapshot: snapshot))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BremLogicWidgetEntry>) -> Void) {
        Task {
            let snapshot: BremLogicWidgetSnapshot
            do {
                snapshot = try await BremLogicWidgetServerClient.fetch()
                try? BremLogicWidgetStore.save(snapshot)
            } catch {
                snapshot = BremLogicWidgetStore.load()
            }

            let entry = BremLogicWidgetEntry(date: Date(), snapshot: snapshot)
            let refreshDate = Date().addingTimeInterval(refreshInterval(for: snapshot))
            completion(Timeline(entries: [entry], policy: .after(refreshDate)))
        }
    }
}

struct BremLogicWidgetEntryView: View {
    let entry: BremLogicWidgetEntry
    @Environment(\.widgetFamily) private var widgetFamily

    private var brandPrimary: Color {
        Color(red: 0.57, green: 0.94, blue: 0.78)
    }

    private func balanceLabel(_ balance: Double?) -> String {
        guard let balance else { return "--" }
        return String(format: "$%.2f", balance)
    }

    private func priceLabel(_ price: Double?) -> String {
        guard let price else { return "--" }
        if price >= 1_000 {
            return String(format: "$%.0f", price)
        }
        return String(format: "$%.2f", price)
    }

    private func leverageLabel(_ leverage: Double?) -> String {
        guard let leverage else { return "--" }
        if leverage.rounded() == leverage {
            return "\(Int(leverage))x"
        }
        return String(format: "%.1fx", leverage)
    }

    private func expectedPnlLabel(_ pnl: Double?) -> String {
        guard let pnl else { return "--" }
        let prefix = pnl >= 0 ? "+" : "-"
        return "\(prefix)$\(String(format: "%.2f", abs(pnl)))"
    }

    private var pnlLabel: String? {
        guard let pnl = entry.snapshot.openPerpPnlUsd else { return nil }
        let prefix = pnl >= 0 ? "+" : "-"
        return "\(prefix)$\(String(format: "%.2f", abs(pnl)))"
    }

    private var pnlPercentLabel: String? {
        guard let pnlPercent = entry.snapshot.openPerpPnlPercent else { return nil }
        let prefix = pnlPercent >= 0 ? "+" : "-"
        return "\(prefix)\(String(format: "%.2f", abs(pnlPercent)))%"
    }

    private var pnlColor: Color {
        guard let pnl = entry.snapshot.openPerpPnlUsd else {
            return .white.opacity(0.72)
        }

        if pnl > 0 {
            return Color(red: 0.45, green: 0.92, blue: 0.62)
        }

        if pnl < 0 {
            return Color(red: 1.0, green: 0.45, blue: 0.45)
        }

        return .white.opacity(0.72)
    }

    private var openPerpLabel: String {
        let label = entry.snapshot.openPerpLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (label?.isEmpty == false ? label! : "No open perps")
    }

    private var openPerpDetail: String {
        let detail = entry.snapshot.openPerpDetail?.trimmingCharacters(in: .whitespacesAndNewlines)
        return detail?.isEmpty == false ? detail! : "Open the app to connect a live Perps session."
    }

    private var hasOpenPerp: Bool {
        entry.snapshot.openPerpMarket != nil || entry.snapshot.openPerpPnlUsd != nil
    }

    private var updatedLabel: String {
        Date(timeIntervalSince1970: entry.snapshot.updatedAt).formatted(date: .omitted, time: .shortened)
    }

    private var chartCandles: [BremLogicWidgetCandle] {
        entry.snapshot.chartCandles ?? []
    }

    private func chart(height: CGFloat) -> some View {
        BremLogicCandlestickChart(
            candles: chartCandles,
            symbol: entry.snapshot.chartSymbol ?? entry.snapshot.openPerpMarket,
            entryPrice: entry.snapshot.openPerpEntryPrice,
            markPrice: entry.snapshot.openPerpMarkPrice,
            takeProfitPrice: entry.snapshot.openPerpTakeProfitPrice,
            stopLossPrice: entry.snapshot.openPerpStopLossPrice,
            liquidationPrice: entry.snapshot.openPerpLiquidationPrice
        )
        .frame(height: height)
    }

    private var flexibleChart: some View {
        GeometryReader { geometry in
            chart(height: max(1, geometry.size.height))
                .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }

    private var compactChart: some View {
        GeometryReader { geometry in
            BremLogicCandlestickChart(
                candles: chartCandles,
                symbol: entry.snapshot.chartSymbol ?? entry.snapshot.openPerpMarket,
                entryPrice: entry.snapshot.openPerpEntryPrice,
                markPrice: entry.snapshot.openPerpMarkPrice,
                takeProfitPrice: entry.snapshot.openPerpTakeProfitPrice,
                stopLossPrice: entry.snapshot.openPerpStopLossPrice,
                liquidationPrice: nil
            )
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }

    private var widgetBackground: LinearGradient {
        LinearGradient(
            colors: [
                Color(red: 0.07, green: 0.09, blue: 0.15),
                Color(red: 0.03, green: 0.04, blue: 0.08),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    @ViewBuilder
    private func applyWidgetBackground<Content: View>(to content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.containerBackground(widgetBackground, for: .widget)
        } else {
            ZStack {
                widgetBackground
                content
            }
        }
    }

    @ViewBuilder
    private var brandLogo: some View {
        if let image = UIImage(named: "BremLogicLogo")
            ?? BremLogicWidgetAssetLoader.logoImage() {
            Image(uiImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(
                    width: widgetFamily == .systemSmall ? 54 : widgetFamily == .systemMedium ? 72 : widgetFamily == .systemExtraLarge ? 108 : 84,
                    height: widgetFamily == .systemSmall ? 18 : widgetFamily == .systemExtraLarge ? 28 : 22,
                    alignment: .leading
                )
        } else {
            Text("BremLogic")
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    @ViewBuilder
    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .top, spacing: 4) {
                brandLogo
                    .layoutPriority(0)
                Spacer(minLength: 4)
                Text(updatedLabel)
                    .font(.system(size: 8, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.58))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(2)
            }
            .frame(maxWidth: .infinity)

            if hasOpenPerp {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(openPerpLabel)
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 2)
                    Text([pnlLabel, pnlPercentLabel].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(pnlColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }

                compactChart
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .layoutPriority(1)

                HStack(spacing: 3) {
                    smallMetric("MARK", priceLabel(entry.snapshot.openPerpMarkPrice), accent: pnlColor)
                    smallMetric("TP", priceLabel(entry.snapshot.openPerpTakeProfitPrice), accent: brandPrimary)
                    smallMetric("SL", priceLabel(entry.snapshot.openPerpStopLossPrice), accent: .red.opacity(0.9))
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("NO OPEN PERPS")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 2)
                    Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                        .font(.system(size: 6, weight: .bold, design: .rounded))
                        .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? brandPrimary : .white.opacity(0.52))
                        .lineLimit(1)
                }

                compactChart
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .layoutPriority(1)

                HStack(spacing: 3) {
                    smallMetric("AGENT WALLET", balanceLabel(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
                    smallMetric("MARK", priceLabel(entry.snapshot.openPerpMarkPrice), accent: Color(red: 0.36, green: 0.68, blue: 0.98))
                }
            }
        }
    }

    private func smallMetric(_ title: String, _ value: String, accent: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.system(size: 5.5, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.46))
                .lineLimit(1)
            Text(value)
                .font(.system(size: 8, weight: .bold, design: .rounded))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    @ViewBuilder
    private var mediumContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            sessionHeader

            if hasOpenPerp {
                GeometryReader { geometry in
                    let leftWidth = max(112, geometry.size.width * 0.31)
                    HStack(spacing: 6) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(openPerpLabel)
                                .font(.system(size: 14, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Text([pnlLabel, pnlPercentLabel].compactMap { $0 }.joined(separator: "  ·  "))
                                .font(.system(size: 9, weight: .bold, design: .rounded))
                                .foregroundStyle(pnlColor)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
                                smallMetric("ENTRY", priceLabel(entry.snapshot.openPerpEntryPrice))
                                smallMetric("MARK", priceLabel(entry.snapshot.openPerpMarkPrice), accent: pnlColor)
                                smallMetric("LEVERAGE", leverageLabel(entry.snapshot.openPerpLeverage))
                                smallMetric("TAKE PROFIT", priceLabel(entry.snapshot.openPerpTakeProfitPrice), accent: brandPrimary)
                                smallMetric("STOP LOSS", priceLabel(entry.snapshot.openPerpStopLossPrice), accent: .red.opacity(0.9))
                            }
                        }
                        .frame(width: leftWidth, height: geometry.size.height, alignment: .topLeading)

                        flexibleChart
                            .frame(width: max(1, geometry.size.width - leftWidth - 6), height: geometry.size.height)
                    }
                }
            } else {
                GeometryReader { geometry in
                    let leftWidth = max(112, geometry.size.width * 0.31)
                    HStack(spacing: 6) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("OPEN PERPS")
                                .font(.system(size: 8, weight: .semibold, design: .rounded))
                                .foregroundStyle(brandPrimary)
                            Text("No open positions")
                                .font(.system(size: 14, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                            Text(openPerpDetail)
                                .font(.system(size: 8, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.66))
                                .lineLimit(2)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
                                smallMetric("AGENT", balanceLabel(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
                                smallMetric("MARK", priceLabel(entry.snapshot.openPerpMarkPrice), accent: Color(red: 0.36, green: 0.68, blue: 0.98))
                            }
                        }
                        .frame(width: leftWidth, height: geometry.size.height, alignment: .topLeading)

                        flexibleChart
                            .frame(width: max(1, geometry.size.width - leftWidth - 6), height: geometry.size.height)
                    }
                }
            }
        }
    }

    private func metricTile(_ title: String, _ value: String, accent: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title.uppercased())
                .font(.system(size: widgetFamily == .systemExtraLarge ? 8.5 : 7, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
                .lineLimit(1)
            Text(value)
                .font(.system(size: widgetFamily == .systemExtraLarge ? 13 : 10.5, weight: .bold, design: .rounded))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, widgetFamily == .systemExtraLarge ? 8 : 6)
        .padding(.vertical, widgetFamily == .systemExtraLarge ? 6 : 4)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: widgetFamily == .systemExtraLarge ? 9 : 7, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: widgetFamily == .systemExtraLarge ? 9 : 7, style: .continuous)
                .stroke(Color.white.opacity(0.065), lineWidth: 1)
        }
    }

    private var sessionHeader: some View {
        HStack(spacing: 8) {
            brandLogo
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? brandPrimary : .white.opacity(0.64))
                if widgetFamily != .systemMedium {
                    Text("Updated \(updatedLabel)")
                        .font(.system(size: 8, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            if #available(iOS 17.0, *) {
                Button(intent: BremLogicWidgetRefreshIntent()) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(brandPrimary)
                        .frame(width: 26, height: 26)
                        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh BremLogic widget")
            }
        }
    }

    private var positionSummary: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("OPEN PERPS")
                .font(.system(size: widgetFamily == .systemExtraLarge ? 11 : 9, weight: .semibold, design: .rounded))
                .foregroundStyle(brandPrimary)
            Text(openPerpLabel)
                .font(.system(size: widgetFamily == .systemExtraLarge ? 28 : 20, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.68)
            Text(openPerpDetail)
                .font(.system(size: widgetFamily == .systemExtraLarge ? 11 : 9, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.68))
                .lineLimit(1)
                .minimumScaleFactor(0.45)
        }
    }

    private var pnlPanel: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("UNREALIZED PNL")
                .font(.system(size: widgetFamily == .systemExtraLarge ? 9 : 7, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
            Text(pnlLabel ?? "--")
                .font(.system(size: widgetFamily == .systemExtraLarge ? 27 : 17, weight: .bold, design: .rounded))
                .foregroundStyle(pnlColor)
                .lineLimit(1)
                .minimumScaleFactor(0.68)
            if let pnlPercentLabel {
                Text(pnlPercentLabel)
                    .font(.system(size: widgetFamily == .systemExtraLarge ? 11 : 9, weight: .bold, design: .rounded))
                    .foregroundStyle(pnlColor.opacity(0.9))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(7)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.white.opacity(0.065), lineWidth: 1)
        }
    }

    private var walletStatusGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 2), spacing: 4) {
            metricTile("Main Wallet", balanceLabel(entry.snapshot.mainWalletBalanceUsd))
            metricTile("Agent Wallet", balanceLabel(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
            metricTile("Mode", entry.snapshot.perpsMode ?? "Paper mode")
            metricTile("Execution", entry.snapshot.perpsExecutionModel == "delegated-ready" ? "Delegated" : "Assisted")
        }
    }

    private var tradeMetricGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 4) {
            metricTile("Position", balanceLabel(entry.snapshot.openPerpPositionValueUsd))
            metricTile("Collateral", balanceLabel(entry.snapshot.openPerpCollateralUsd))
            metricTile("Entry", priceLabel(entry.snapshot.openPerpEntryPrice))
            metricTile("Mark", priceLabel(entry.snapshot.openPerpMarkPrice))
            metricTile("Leverage", leverageLabel(entry.snapshot.openPerpLeverage))
            metricTile("Liquidation", priceLabel(entry.snapshot.openPerpLiquidationPrice), accent: .orange.opacity(0.9))
            metricTile("Take Profit", priceLabel(entry.snapshot.openPerpTakeProfitPrice), accent: brandPrimary)
            metricTile("TP P/L", expectedPnlLabel(entry.snapshot.openPerpTakeProfitPnlUsd), accent: Color(red: 0.45, green: 0.92, blue: 0.62))
            metricTile("Stop Loss", priceLabel(entry.snapshot.openPerpStopLossPrice), accent: Color(red: 1, green: 0.45, blue: 0.45))
            metricTile("SL P/L", expectedPnlLabel(entry.snapshot.openPerpStopLossPnlUsd), accent: Color(red: 1, green: 0.45, blue: 0.45))
        }
    }

    private var idleMetricGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
            metricTile("Main Wallet", balanceLabel(entry.snapshot.mainWalletBalanceUsd))
            metricTile("Agent Wallet", balanceLabel(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
            metricTile("Mark", priceLabel(entry.snapshot.openPerpMarkPrice), accent: Color(red: 0.36, green: 0.68, blue: 0.98))
            metricTile("Mode", entry.snapshot.perpsMode ?? "Paper mode")
            metricTile("Execution", entry.snapshot.perpsExecutionModel == "delegated-ready" ? "Delegated" : "Assisted")
            metricTile("Updated", updatedLabel)
        }
    }

    @ViewBuilder
    private var largeContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            sessionHeader

            if hasOpenPerp {
                GeometryReader { geometry in
                    let summaryHeight = max(72, geometry.size.height * 0.30)
                    let lowerHeight = max(1, geometry.size.height - summaryHeight - 6)
                    let railWidth = max(96, geometry.size.width * 0.24)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top, spacing: 7) {
                            positionSummary
                                .frame(width: max(108, geometry.size.width * 0.39), height: summaryHeight, alignment: .leading)
                            tradeMetricGrid
                                .frame(maxWidth: .infinity, maxHeight: summaryHeight, alignment: .top)
                        }
                        .frame(height: summaryHeight)

                        HStack(spacing: 7) {
                            VStack(spacing: 4) {
                                pnlPanel
                                walletStatusGrid
                            }
                            .frame(width: railWidth, height: lowerHeight)

                            flexibleChart
                                .frame(width: max(1, geometry.size.width - railWidth - 7), height: lowerHeight)
                        }
                        .frame(height: lowerHeight)
                    }
                }
            } else {
                GeometryReader { geometry in
                    let summaryHeight = max(72, geometry.size.height * 0.30)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top, spacing: 7) {
                            positionSummary
                                .frame(width: max(108, geometry.size.width * 0.39), height: summaryHeight, alignment: .leading)
                            idleMetricGrid
                                .frame(maxWidth: .infinity, maxHeight: summaryHeight, alignment: .top)
                        }
                        .frame(height: summaryHeight)

                        flexibleChart
                            .frame(width: geometry.size.width, height: max(1, geometry.size.height - summaryHeight - 6))
                    }
                }
            }

        }
    }

    @ViewBuilder
    private var extraLargeContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            sessionHeader

            if hasOpenPerp {
                GeometryReader { geometry in
                    let railWidth = max(310, geometry.size.width * 0.39)
                    let heroHeight = max(94, geometry.size.height * 0.28)

                    HStack(alignment: .top, spacing: 9) {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(alignment: .top, spacing: 7) {
                                positionSummary
                                pnlPanel
                                    .frame(width: max(112, railWidth * 0.36))
                            }
                            .frame(height: heroHeight)

                            tradeMetricGrid
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

                            walletStatusGrid
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        }
                        .frame(width: railWidth, height: geometry.size.height, alignment: .top)

                        flexibleChart
                            .frame(width: max(1, geometry.size.width - railWidth - 9), height: geometry.size.height)
                    }
                    .frame(width: geometry.size.width, height: geometry.size.height)
                }
            } else {
                GeometryReader { geometry in
                    let railWidth = max(310, geometry.size.width * 0.39)
                    HStack(alignment: .top, spacing: 9) {
                        VStack(alignment: .leading, spacing: 9) {
                            positionSummary
                            idleMetricGrid
                        }
                        .frame(width: railWidth, height: geometry.size.height, alignment: .top)

                        flexibleChart
                            .frame(width: max(1, geometry.size.width - railWidth - 9), height: geometry.size.height)
                    }
                }
            }

        }
    }

    var body: some View {
        applyWidgetBackground(
            to: Group {
                if widgetFamily == .systemExtraLarge {
                    extraLargeContent
                } else if widgetFamily == .systemLarge {
                    largeContent
                } else if widgetFamily == .systemMedium {
                    mediumContent
                } else {
                    compactContent
                }
            }
        )
        .padding(.horizontal, widgetFamily == .systemSmall ? 5 : widgetFamily == .systemMedium ? 6 : 8)
        .padding(.vertical, widgetFamily == .systemSmall ? 4 : widgetFamily == .systemMedium ? 6 : 8)
        .widgetURL(URL(string: entry.snapshot.targetURL))
    }
}

struct BremLogicWidget: Widget {
    let kind = "BremLogicWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWidgetProvider()) { entry in
            BremLogicWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("BremLogic Signals")
        .description("Shows the latest BremLogic Perps position and wallet summary.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
        // CarPlay and StandBy require the systemSmall background to be removable.
        .containerBackgroundRemovable(true)
    }
}

@available(iOS 16.0, *)
struct BremLogicLockScreenWidgetEntryView: View {
    let entry: BremLogicWidgetEntry
    @Environment(\.widgetFamily) private var widgetFamily

    private var positionLabel: String {
        let label = entry.snapshot.openPerpLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        return label?.isEmpty == false ? label! : "No open perps"
    }

    private var marketLabel: String {
        let market = entry.snapshot.openPerpMarket?.trimmingCharacters(in: .whitespacesAndNewlines)
        return market?.isEmpty == false ? market! : "PERPS"
    }

    private var pnlLabel: String {
        guard let pnl = entry.snapshot.openPerpPnlUsd else { return "--" }
        let prefix = pnl >= 0 ? "+" : "-"
        return "\(prefix)$\(String(format: "%.2f", abs(pnl)))"
    }

    private var pnlPercentLabel: String {
        guard let percent = entry.snapshot.openPerpPnlPercent else { return "--" }
        let prefix = percent >= 0 ? "+" : "-"
        return "\(prefix)\(String(format: "%.1f", abs(percent)))%"
    }

    private var strategyLabel: String {
        let strategy = entry.snapshot.openPerpStrategy?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        return strategy?.isEmpty == false ? strategy! : "PERPS"
    }

    private func priceLabel(_ value: Double?) -> String {
        guard let value, value.isFinite, value > 0 else { return "--" }
        return value >= 1_000
            ? String(format: "$%.0f", value)
            : String(format: "$%.2f", value)
    }

    private var walletLabel: String {
        let balance = entry.snapshot.agentWalletBalanceUsd
            ?? entry.snapshot.walletBalanceUsd
            ?? entry.snapshot.mainWalletBalanceUsd
        guard let balance else { return "--" }
        if abs(balance) >= 10_000 {
            return String(format: "$%.0f", balance)
        }
        return String(format: "$%.2f", balance)
    }

    @ViewBuilder
    private var lockScreenLogo: some View {
        if let image = UIImage(named: "BremLogicLogo")
            ?? BremLogicWidgetAssetLoader.logoImage() {
            Image(uiImage: image)
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 68, height: 14, alignment: .leading)
                .foregroundStyle(.primary)
        } else {
            Text("BremLogic")
                .font(.system(size: 11, weight: .bold, design: .rounded))
        }
    }

    @ViewBuilder
    private var rectangularContent: some View {
        if entry.snapshot.openPerpMarket?.isEmpty == false || entry.snapshot.openPerpPnlUsd != nil {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(positionLabel) • \(strategyLabel)")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)

                Text("\(pnlLabel)  (\(pnlPercentLabel))")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)

                Text(
                    "M \(priceLabel(entry.snapshot.openPerpMarkPrice))"
                    + " • TP \(priceLabel(entry.snapshot.openPerpTakeProfitPrice))"
                    + " • SL \(priceLabel(entry.snapshot.openPerpStopLossPrice))"
                )
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.62)
            }
        } else {
            VStack(alignment: .leading, spacing: 1) {
                Text("NO OPEN PERPS")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .lineLimit(1)
                Text("Wallet \(walletLabel)")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .lineLimit(1)
                Text("Monitoring • Updated \(Date(timeIntervalSince1970: entry.snapshot.updatedAt), style: .time)")
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
    }

    @ViewBuilder
    private var circularContent: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text(marketLabel)
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Text(pnlLabel)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
            }
            .padding(4)
        }
    }

    private var inlineContent: some View {
        Text("BremLogic · \(marketLabel) · \(pnlLabel)")
    }

    @ViewBuilder
    private func applyAccessoryBackground<Content: View>(to content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.containerBackground(.clear, for: .widget)
        } else {
            content
        }
    }

    var body: some View {
        applyAccessoryBackground(
            to: Group {
                switch widgetFamily {
                case .accessoryCircular:
                    circularContent
                case .accessoryInline:
                    inlineContent
                default:
                    rectangularContent
                }
            }
        )
        .widgetURL(URL(string: entry.snapshot.targetURL))
    }
}

#if canImport(ActivityKit)
@available(iOS 16.2, *)
struct BremLogicTradeLiveActivityWidget: Widget {
    private let positive = Color(red: 0.38, green: 0.92, blue: 0.62)
    private let negative = Color(red: 1.0, green: 0.38, blue: 0.42)
    private let mark = Color(red: 0.36, green: 0.68, blue: 0.98)

    private func signedUsd(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "\(value >= 0 ? "+" : "-")$\(String(format: "%.2f", abs(value)))"
    }

    private func percent(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "\(value >= 0 ? "+" : "-")\(String(format: "%.1f", abs(value)))%"
    }

    private func price(_ value: Double?) -> String {
        guard let value, value.isFinite, value > 0 else { return "--" }
        return value >= 1_000 ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
    }

    private func pnlColor(_ state: BremLogicTradeActivityAttributes.ContentState) -> Color {
        guard let pnl = state.pnlUsd else { return .secondary }
        return pnl >= 0 ? positive : negative
    }

    @ViewBuilder
    private var islandBrand: some View {
        if let image = UIImage(named: "BremLogicLogo")
            ?? BremLogicWidgetAssetLoader.logoImage() {
            Image(uiImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 68, height: 17, alignment: .leading)
        } else {
            Text("BremLogic")
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .foregroundStyle(positive)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }

    @ViewBuilder
    private func metric(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func lockScreenView(_ context: ActivityViewContext<BremLogicTradeActivityAttributes>) -> some View {
        let state = context.state
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("BREMLOGIC • \(state.strategy)")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(positive)
                    Text(state.positionLabel)
                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(signedUsd(state.pnlUsd))
                        .font(.system(size: 22, weight: .heavy, design: .rounded))
                        .foregroundStyle(pnlColor(state))
                    Text(percent(state.pnlPercent))
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundStyle(pnlColor(state))
                }
            }

            HStack(spacing: 8) {
                metric("ENTRY", price(state.entryPrice), color: .white)
                metric("MARK", price(state.markPrice), color: mark)
                metric("TAKE PROFIT", price(state.takeProfitPrice), color: positive)
                metric("STOP LOSS", price(state.stopLossPrice), color: negative)
            }
        }
        .padding(14)
        .activityBackgroundTint(Color(red: 0.045, green: 0.06, blue: 0.095))
        .activitySystemActionForegroundColor(.white)
        .widgetURL(URL(string: state.targetURL))
    }

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BremLogicTradeActivityAttributes.self) { context in
            lockScreenView(context)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    islandBrand
                }
                .contentMargins(.leading, 27)
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(signedUsd(state.pnlUsd))
                            .font(.headline)
                            .foregroundStyle(pnlColor(state))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .monospacedDigit()
                        Text(percent(state.pnlPercent))
                            .font(.caption2.bold())
                            .foregroundStyle(pnlColor(state))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .monospacedDigit()
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .multilineTextAlignment(.trailing)
                }
                .contentMargins(.trailing, 27)
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 7) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(state.positionLabel)
                                .font(.system(size: 16, weight: .heavy, design: .rounded))
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                            Spacer(minLength: 4)
                            Text(state.strategy)
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                                .foregroundStyle(positive)
                                .lineLimit(1)
                                .minimumScaleFactor(0.72)
                        }

                        HStack(spacing: 4) {
                            metric("ENTRY", price(state.entryPrice), color: .white)
                            metric("MARK", price(state.markPrice), color: mark)
                            metric("TP", price(state.takeProfitPrice), color: positive)
                            metric("SL", price(state.stopLossPrice), color: negative)
                        }
                    }
                    .padding(.horizontal, 12)
                }
            } compactLeading: {
                Text(state.market)
                    .font(.caption2.bold())
            } compactTrailing: {
                Text(signedUsd(state.pnlUsd))
                    .font(.caption2.bold())
                    .foregroundStyle(pnlColor(state))
            } minimal: {
                Image(systemName: state.pnlUsd ?? 0 >= 0 ? "arrow.up.right" : "arrow.down.right")
                    .foregroundStyle(pnlColor(state))
            }
            .widgetURL(URL(string: state.targetURL))
            .keylineTint(pnlColor(state))
        }
    }
}
#endif

@available(iOS 16.0, *)
struct BremLogicLockScreenWidget: Widget {
    let kind = "BremLogicLockScreenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWidgetProvider()) { entry in
            BremLogicLockScreenWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("BremLogic Lock Screen")
        .description("Shows your open Perps position, PnL, and wallet value on the Lock Screen.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

enum BremLogicWidgetAssetLoader {
    static func logoImage() -> UIImage? {
        guard let path = Bundle.main.path(forResource: "BremLogicLogo", ofType: "png") else {
            return nil
        }

        return UIImage(contentsOfFile: path)
    }
}
