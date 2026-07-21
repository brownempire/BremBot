import AppKit
import SwiftUI
import WidgetKit

struct BremLogicMacWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: BremLogicWidgetSnapshot
}

struct BremLogicMacWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> BremLogicMacWidgetEntry {
        BremLogicMacWidgetEntry(date: Date(), snapshot: .fallback)
    }

    func getSnapshot(in context: Context, completion: @escaping (BremLogicMacWidgetEntry) -> Void) {
        guard !context.isPreview else {
            completion(placeholder(in: context))
            return
        }

        loadEntry(completion: completion)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BremLogicMacWidgetEntry>) -> Void) {
        loadEntry { entry in
            let market = entry.snapshot.openPerpMarket?.trimmingCharacters(in: .whitespacesAndNewlines)
            let hasOpenPerp = market?.isEmpty == false
                || entry.snapshot.openPerpPositionValueUsd != nil
                || entry.snapshot.openPerpPnlUsd != nil
            let refreshInterval: TimeInterval = hasOpenPerp ? 5 * 60 : 15 * 60
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(refreshInterval))))
        }
    }

    private func loadEntry(completion: @escaping (BremLogicMacWidgetEntry) -> Void) {
        Task {
            let snapshot: BremLogicWidgetSnapshot
            do {
                snapshot = try await BremLogicWidgetServerClient.fetch()
                try? BremLogicWidgetStore.save(snapshot)
            } catch {
                snapshot = BremLogicWidgetStore.load()
            }
            completion(BremLogicMacWidgetEntry(date: Date(), snapshot: snapshot))
        }
    }
}

struct BremLogicMacWidgetEntryView: View {
    let entry: BremLogicMacWidgetEntry
    private let previewFamily: WidgetFamily?
    @Environment(\.widgetFamily) private var environmentFamily

    init(entry: BremLogicMacWidgetEntry, previewFamily: WidgetFamily? = nil) {
        self.entry = entry
        self.previewFamily = previewFamily
    }

    private var family: WidgetFamily {
        previewFamily ?? environmentFamily
    }

    private let mint = Color(red: 0.57, green: 0.94, blue: 0.78)
    private let positive = Color(red: 0.45, green: 0.92, blue: 0.62)
    private let negative = Color(red: 1.0, green: 0.45, blue: 0.45)

    private var background: LinearGradient {
        LinearGradient(
            colors: [Color(red: 0.07, green: 0.09, blue: 0.15), Color(red: 0.03, green: 0.04, blue: 0.08)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var hasOpenPerp: Bool {
        entry.snapshot.openPerpMarket?.isEmpty == false || entry.snapshot.openPerpPnlUsd != nil
    }

    private var positionLabel: String {
        let label = entry.snapshot.openPerpLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        return label?.isEmpty == false ? label! : "No open perps"
    }

    private var detailLabel: String {
        let detail = entry.snapshot.openPerpDetail?.trimmingCharacters(in: .whitespacesAndNewlines)
        return detail?.isEmpty == false ? detail! : "No open positions"
    }

    private var pnlColor: Color {
        guard let pnl = entry.snapshot.openPerpPnlUsd else { return .white.opacity(0.7) }
        return pnl > 0 ? positive : pnl < 0 ? negative : .white.opacity(0.7)
    }

    private var updatedLabel: String {
        Date(timeIntervalSince1970: entry.snapshot.updatedAt).formatted(date: .omitted, time: .shortened)
    }

    private var chartCandles: [BremLogicWidgetCandle] {
        entry.snapshot.chartCandles ?? []
    }

    private var pnlSummary: String {
        let amount = usd(entry.snapshot.openPerpPnlUsd, signed: true)
        guard let percent = entry.snapshot.openPerpPnlPercent else { return amount }
        return "\(amount)  ·  \(percent >= 0 ? "+" : "-")\(String(format: "%.2f", abs(percent)))%"
    }

    private var pnlPercentLabel: String? {
        guard let percent = entry.snapshot.openPerpPnlPercent else { return nil }
        return "\(percent >= 0 ? "+" : "-")\(String(format: "%.2f", abs(percent)))%"
    }

    private func chart(height: CGFloat) -> some View {
        BremLogicCandlestickChart(
            candles: chartCandles,
            symbol: entry.snapshot.chartSymbol ?? entry.snapshot.openPerpMarket,
            entryPrice: entry.snapshot.openPerpEntryPrice,
            markPrice: entry.snapshot.openPerpMarkPrice,
            takeProfitPrice: entry.snapshot.openPerpTakeProfitPrice
        )
        .frame(height: height)
    }

    private var flexibleChart: some View {
        GeometryReader { geometry in
            chart(height: max(1, geometry.size.height))
                .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }

    private func usd(_ value: Double?, signed: Bool = false) -> String {
        guard let value else { return "--" }
        if signed {
            return "\(value >= 0 ? "+" : "-")$\(String(format: "%.2f", abs(value)))"
        }
        return String(format: "$%.2f", value)
    }

    private func price(_ value: Double?) -> String {
        guard let value else { return "--" }
        return value >= 1_000 ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
    }

    private func leverage(_ value: Double?) -> String {
        guard let value else { return "--" }
        return value.rounded() == value ? "\(Int(value))x" : String(format: "%.1fx", value)
    }

    @ViewBuilder
    private var logo: some View {
        if let image = BremLogicMacWidgetAssetLoader.logoImage() {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(
                    width: family == .systemSmall ? 54 : family == .systemMedium ? 72 : family == .systemExtraLarge ? 108 : 90,
                    height: family == .systemSmall ? 18 : family == .systemExtraLarge ? 28 : 22,
                    alignment: .leading
                )
        } else {
            Text("BremLogic")
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    private func metric(_ title: String, _ value: String, color: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title.uppercased())
                .font(.system(size: family == .systemExtraLarge ? 8.5 : 7, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
                .lineLimit(1)
            Text(value)
                .font(.system(size: family == .systemExtraLarge ? 13 : 10.5, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, family == .systemExtraLarge ? 8 : 6)
        .padding(.vertical, family == .systemExtraLarge ? 6 : 4)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: family == .systemExtraLarge ? 9 : 7, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: family == .systemExtraLarge ? 9 : 7, style: .continuous)
                .stroke(Color.white.opacity(0.065), lineWidth: 1)
        }
    }

    private var positionSummary: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("OPEN PERPS")
                .font(.system(size: family == .systemExtraLarge ? 11 : 9, weight: .semibold, design: .rounded))
                .foregroundStyle(mint)
            Text(positionLabel)
                .font(.system(size: family == .systemExtraLarge ? 28 : 20, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.68)
            Text(detailLabel)
                .font(.system(size: family == .systemExtraLarge ? 11 : 9, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.68))
                .lineLimit(1)
                .minimumScaleFactor(0.45)
        }
    }

    private var pnlPanel: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("UNREALIZED PNL")
                .font(.system(size: family == .systemExtraLarge ? 9 : 7, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
            Text(usd(entry.snapshot.openPerpPnlUsd, signed: true))
                .font(.system(size: family == .systemExtraLarge ? 27 : 17, weight: .bold, design: .rounded))
                .foregroundStyle(pnlColor)
                .lineLimit(1)
                .minimumScaleFactor(0.68)
            if let pnlPercentLabel {
                Text(pnlPercentLabel)
                    .font(.system(size: family == .systemExtraLarge ? 11 : 9, weight: .bold, design: .rounded))
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
            metric("Main Wallet", usd(entry.snapshot.mainWalletBalanceUsd))
            metric("Agent Wallet", usd(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
            metric("Mode", entry.snapshot.perpsMode ?? "Paper mode")
            metric("Execution", entry.snapshot.perpsExecutionModel == "delegated-ready" ? "Delegated" : "Assisted")
        }
    }

    private var tradeMetricGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 4) {
            metric("Position", usd(entry.snapshot.openPerpPositionValueUsd))
            metric("Collateral", usd(entry.snapshot.openPerpCollateralUsd))
            metric("Entry", price(entry.snapshot.openPerpEntryPrice))
            metric("Mark", price(entry.snapshot.openPerpMarkPrice))
            metric("Leverage", leverage(entry.snapshot.openPerpLeverage))
            metric("Liquidation", price(entry.snapshot.openPerpLiquidationPrice), color: .orange)
            metric("Take Profit", price(entry.snapshot.openPerpTakeProfitPrice), color: mint)
            metric("TP P/L", usd(entry.snapshot.openPerpTakeProfitPnlUsd, signed: true), color: positive)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            logo
                .layoutPriority(0)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? mint : .white.opacity(0.65))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                if family != .systemMedium {
                    Text("Updated \(updatedLabel)")
                        .font(.system(size: 8, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.5))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .layoutPriority(2)
            if family != .systemSmall {
                refreshButton
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            header
            if hasOpenPerp {
                Text(positionLabel)
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(pnlSummary)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(pnlColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.68)
                HStack(spacing: 3) {
                    compactMetric("ENTRY", price(entry.snapshot.openPerpEntryPrice))
                    compactMetric("MARK", price(entry.snapshot.openPerpMarkPrice), color: pnlColor)
                }
                HStack(spacing: 3) {
                    compactMetric("LEVERAGE", leverage(entry.snapshot.openPerpLeverage))
                    compactMetric("TAKE PROFIT", price(entry.snapshot.openPerpTakeProfitPrice), color: mint)
                }
            } else {
                Text("OPEN PERPS")
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .foregroundStyle(mint)
                Text(positionLabel)
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text(detailLabel)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                Text(entry.snapshot.perpsAutoTradeStatus ?? "Agent status unavailable")
                    .font(.system(size: 6, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(1)
                    .minimumScaleFactor(0.62)
                Spacer(minLength: 2)
                compactRefreshButton
            }
        }
    }

    private func compactMetric(_ title: String, _ value: String, color: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.system(size: 5.5, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.45))
                .lineLimit(1)
            Text(value)
                .font(.system(size: 8, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private var compactRefreshButton: some View {
        Button(intent: BremLogicMacWidgetRefreshIntent()) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(mint)
                .frame(width: 20, height: 18)
                .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh BremLogic widget")
    }

    private var mediumContent: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
            if hasOpenPerp {
                GeometryReader { geometry in
                    let summaryHeight = max(38, geometry.size.height * 0.34)
                    let lowerHeight = max(1, geometry.size.height - summaryHeight - 4)
                    let railWidth = max(82, geometry.size.width * 0.22)

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .top, spacing: 5) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("OPEN PERPS")
                                    .font(.system(size: 6.5, weight: .semibold, design: .rounded))
                                    .foregroundStyle(mint)
                                Text(positionLabel)
                                    .font(.system(size: 13, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.7)
                                Text(detailLabel)
                                    .font(.system(size: 6.5, weight: .medium, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.58))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.5)
                            }
                            .frame(width: max(102, geometry.size.width * 0.30), height: summaryHeight, alignment: .topLeading)

                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 4), spacing: 3) {
                                compactMetric("ENTRY", price(entry.snapshot.openPerpEntryPrice))
                                compactMetric("MARK", price(entry.snapshot.openPerpMarkPrice), color: pnlColor)
                                compactMetric("LEVERAGE", leverage(entry.snapshot.openPerpLeverage))
                                compactMetric("TAKE PROFIT", price(entry.snapshot.openPerpTakeProfitPrice), color: mint)
                            }
                            .frame(maxWidth: .infinity, maxHeight: summaryHeight, alignment: .top)
                        }
                        .frame(height: summaryHeight)

                        HStack(spacing: 5) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("UNREALIZED PNL")
                                    .font(.system(size: 5.5, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.48))
                                Text(usd(entry.snapshot.openPerpPnlUsd, signed: true))
                                    .font(.system(size: 13, weight: .bold, design: .rounded))
                                    .foregroundStyle(pnlColor)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.65)
                                if let pnlPercentLabel {
                                    Text(pnlPercentLabel)
                                        .font(.system(size: 7, weight: .bold, design: .rounded))
                                        .foregroundStyle(pnlColor.opacity(0.9))
                                }
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                            .padding(5)
                            .frame(width: railWidth, height: lowerHeight)
                            .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .stroke(Color.white.opacity(0.065), lineWidth: 1)
                            }

                            flexibleChart
                                .frame(width: max(1, geometry.size.width - railWidth - 5), height: lowerHeight)
                        }
                        .frame(height: lowerHeight)
                    }
                }
            } else {
                Text(detailLabel)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.65))
                    .frame(maxHeight: .infinity, alignment: .center)
            }
        }
    }

    private var largeContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            header

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
                Text(detailLabel)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.65))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }

    private var extraLargeContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            header

            if hasOpenPerp {
                GeometryReader { geometry in
                    let summaryHeight = max(94, geometry.size.height * 0.28)
                    let lowerHeight = max(1, geometry.size.height - summaryHeight - 8)
                    let railWidth = max(156, geometry.size.width * 0.24)

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top, spacing: 8) {
                            positionSummary
                                .frame(width: max(210, geometry.size.width * 0.39), height: summaryHeight, alignment: .leading)
                            tradeMetricGrid
                                .frame(maxWidth: .infinity, maxHeight: summaryHeight, alignment: .top)
                        }
                        .frame(height: summaryHeight)

                        HStack(spacing: 8) {
                            VStack(spacing: 6) {
                                pnlPanel
                                walletStatusGrid
                            }
                            .frame(width: railWidth, height: lowerHeight)

                            flexibleChart
                                .frame(width: max(1, geometry.size.width - railWidth - 8), height: lowerHeight)
                        }
                        .frame(height: lowerHeight)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("OPEN PERPS")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(mint)
                    Text("No open positions")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(detailLabel)
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.68))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.top, 16)
            }
        }
    }

    private var refreshButton: some View {
        Button(intent: BremLogicMacWidgetRefreshIntent()) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(mint)
                .frame(width: 32, height: 32)
                .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh BremLogic widget")
    }

    var body: some View {
        Group {
            if family == .systemExtraLarge {
                extraLargeContent
            } else if family == .systemLarge {
                largeContent
            } else if family == .systemMedium {
                mediumContent
            } else {
                compactContent
            }
        }
        .padding(family == .systemSmall ? 5 : family == .systemMedium ? 7 : 9)
        .containerBackground(background, for: .widget)
        .widgetURL(URL(string: "https://app.bremlogic.com/signals-bot?tab=perps"))
    }
}

struct BremLogicMacWidget: Widget {
    let kind = "BremLogicMacWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicMacWidgetProvider()) { entry in
            BremLogicMacWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("BremLogic")
        .description("Shows open Perps, PnL, and wallet values on your Mac desktop.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}

enum BremLogicMacWidgetAssetLoader {
    static func logoImage() -> NSImage? {
        guard let path = Bundle.main.path(forResource: "BremLogicLogo", ofType: "png") else {
            return nil
        }
        return NSImage(contentsOfFile: path)
    }
}
