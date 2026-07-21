import SwiftUI
import UIKit
import WidgetKit

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
        return hasOpenPerp ? 5 * 60 : 15 * 60
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
            takeProfitPrice: entry.snapshot.openPerpTakeProfitPrice
        )
        .frame(height: height)
    }

    private func chartRow<Leading: View>(
        height: CGFloat,
        @ViewBuilder leading: @escaping () -> Leading
    ) -> some View {
        GeometryReader { geometry in
            let columnWidth = max(1, (geometry.size.width - 6) * 0.5)
            HStack(spacing: 6) {
                leading()
                    .frame(width: columnWidth, height: height, alignment: .center)
                chart(height: height)
                    .frame(width: columnWidth, height: height)
            }
        }
        .frame(height: height)
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
                    width: widgetFamily == .systemSmall ? 54 : widgetFamily == .systemMedium ? 72 : 84,
                    height: widgetFamily == .systemSmall ? 18 : 22,
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
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(openPerpLabel)
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Spacer(minLength: 2)
                    Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                        .font(.system(size: 6, weight: .bold, design: .rounded))
                        .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? brandPrimary : .white.opacity(0.52))
                        .lineLimit(1)
                }

                Text([pnlLabel, pnlPercentLabel].compactMap { $0 }.joined(separator: "  ·  "))
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(pnlColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)

                HStack(spacing: 3) {
                    smallMetric("ENTRY", priceLabel(entry.snapshot.openPerpEntryPrice))
                    smallMetric("MARK", priceLabel(entry.snapshot.openPerpMarkPrice), accent: pnlColor)
                }
                HStack(spacing: 3) {
                    smallMetric("LEVERAGE", leverageLabel(entry.snapshot.openPerpLeverage))
                    smallMetric("TAKE PROFIT", priceLabel(entry.snapshot.openPerpTakeProfitPrice), accent: brandPrimary)
                }
            } else {
                Text("OPEN PERPS")
                    .font(.system(size: 8, weight: .semibold, design: .rounded))
                    .foregroundStyle(brandPrimary)
                Text(openPerpLabel)
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(openPerpDetail)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.78))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }

            Spacer(minLength: 0)

            HStack(alignment: .center, spacing: 3) {
                Text(entry.snapshot.perpsAutoTradeStatus ?? "Agent status unavailable")
                    .font(.system(size: 6, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.56))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Spacer(minLength: 2)
                if #available(iOS 17.0, *) {
                    Button(intent: BremLogicWidgetRefreshIntent()) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .foregroundStyle(brandPrimary)
                            .frame(width: 20, height: 18)
                            .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Refresh BremLogic widget")
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
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                brandLogo
                VStack(alignment: .leading, spacing: 1) {
                    Text(openPerpLabel)
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text([pnlLabel, pnlPercentLabel].compactMap { $0 }.joined(separator: "  ·  "))
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(pnlColor)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                    .font(.system(size: 8, weight: .bold, design: .rounded))
                    .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? brandPrimary : .white.opacity(0.55))
            }

            if hasOpenPerp {
                chartRow(height: 50) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
                        smallMetric("ENTRY", priceLabel(entry.snapshot.openPerpEntryPrice))
                        smallMetric("MARK", priceLabel(entry.snapshot.openPerpMarkPrice), accent: pnlColor)
                        smallMetric("LEVERAGE", leverageLabel(entry.snapshot.openPerpLeverage))
                        smallMetric("TAKE PROFIT", priceLabel(entry.snapshot.openPerpTakeProfitPrice), accent: brandPrimary)
                    }
                }
            } else {
                Text(openPerpDetail)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.66))
                    .frame(maxHeight: .infinity, alignment: .center)
            }
        }
    }

    private func metricTile(_ title: String, _ value: String, accent: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title.uppercased())
                .font(.system(size: 7, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
                .lineLimit(1)
            Text(value)
                .font(.system(size: 10.5, weight: .bold, design: .rounded))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(Color.white.opacity(0.065), lineWidth: 1)
        }
    }

    @ViewBuilder
    private var largeContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                brandLogo
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? brandPrimary : .white.opacity(0.64))
                    Text("Updated \(updatedLabel)")
                        .font(.system(size: 8, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.5))
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

            if hasOpenPerp {
                HStack(alignment: .bottom, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("OPEN PERPS")
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .foregroundStyle(brandPrimary)
                        Text(openPerpLabel)
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        Text(openPerpDetail)
                            .font(.system(size: 9, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.68))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if let pnlLabel {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("UNREALIZED PNL")
                                .font(.system(size: 7, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.5))
                            Text(pnlLabel)
                                .font(.system(size: 17, weight: .bold, design: .rounded))
                                .foregroundStyle(pnlColor)
                            if let pnlPercentLabel {
                                Text(pnlPercentLabel)
                                    .font(.system(size: 9, weight: .bold, design: .rounded))
                                    .foregroundStyle(pnlColor.opacity(0.9))
                            }
                        }
                    }
                }

                chartRow(height: 64) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 2), spacing: 4) {
                        metricTile("Main Wallet", balanceLabel(entry.snapshot.mainWalletBalanceUsd))
                        metricTile("Agent Wallet", balanceLabel(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
                        metricTile("Mode", entry.snapshot.perpsMode ?? "Paper mode")
                        metricTile("Execution", entry.snapshot.perpsExecutionModel == "delegated-ready" ? "Delegated" : "Assisted")
                    }
                }

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 4) {
                    metricTile("Position", balanceLabel(entry.snapshot.openPerpPositionValueUsd))
                    metricTile("Collateral", balanceLabel(entry.snapshot.openPerpCollateralUsd))
                    metricTile("Entry", priceLabel(entry.snapshot.openPerpEntryPrice))
                    metricTile("Mark", priceLabel(entry.snapshot.openPerpMarkPrice))
                    metricTile("Leverage", leverageLabel(entry.snapshot.openPerpLeverage))
                    metricTile("Liquidation", priceLabel(entry.snapshot.openPerpLiquidationPrice), accent: .orange.opacity(0.9))
                    metricTile("Take Profit", priceLabel(entry.snapshot.openPerpTakeProfitPrice), accent: brandPrimary)
                    metricTile("TP P/L", expectedPnlLabel(entry.snapshot.openPerpTakeProfitPnlUsd), accent: Color(red: 0.45, green: 0.92, blue: 0.62))
                }
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    Text("OPEN PERPS")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(brandPrimary)
                    Text("No open positions")
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(openPerpDetail)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.68))
                }
                .frame(maxHeight: .infinity, alignment: .topLeading)
                .padding(.top, 12)
            }

        }
    }

    @ViewBuilder
    private var extraLargeContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                brandLogo
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? brandPrimary : .white.opacity(0.64))
                    Text("Updated \(updatedLabel)")
                        .font(.system(size: 8, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.5))
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

            if hasOpenPerp {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("OPEN PERPS")
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .foregroundStyle(brandPrimary)
                        Text(openPerpLabel)
                            .font(.system(size: 22, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                        Text(openPerpDetail)
                            .font(.system(size: 9, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.68))
                            .lineLimit(1)
                        if let pnlLabel {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("UNREALIZED PNL")
                                    .font(.system(size: 7, weight: .semibold, design: .rounded))
                                    .foregroundStyle(.white.opacity(0.5))
                                Text(pnlLabel)
                                    .font(.system(size: 19, weight: .bold, design: .rounded))
                                    .foregroundStyle(pnlColor)
                                if let pnlPercentLabel {
                                    Text(pnlPercentLabel)
                                        .font(.system(size: 9, weight: .bold, design: .rounded))
                                        .foregroundStyle(pnlColor.opacity(0.9))
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(8)
                    .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 9, style: .continuous))

                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 4), spacing: 4) {
                        metricTile("Position", balanceLabel(entry.snapshot.openPerpPositionValueUsd))
                        metricTile("Collateral", balanceLabel(entry.snapshot.openPerpCollateralUsd))
                        metricTile("Entry", priceLabel(entry.snapshot.openPerpEntryPrice))
                        metricTile("Mark", priceLabel(entry.snapshot.openPerpMarkPrice))
                        metricTile("Leverage", leverageLabel(entry.snapshot.openPerpLeverage))
                        metricTile("Liquidation", priceLabel(entry.snapshot.openPerpLiquidationPrice), accent: .orange.opacity(0.9))
                        metricTile("Take Profit", priceLabel(entry.snapshot.openPerpTakeProfitPrice), accent: brandPrimary)
                        metricTile("TP P/L", expectedPnlLabel(entry.snapshot.openPerpTakeProfitPnlUsd), accent: Color(red: 0.45, green: 0.92, blue: 0.62))
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                }

                chartRow(height: 66) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 2), spacing: 4) {
                        metricTile("Main Wallet", balanceLabel(entry.snapshot.mainWalletBalanceUsd))
                        metricTile("Agent Wallet", balanceLabel(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
                        metricTile("Mode", entry.snapshot.perpsMode ?? "Paper mode")
                        metricTile("Execution", entry.snapshot.perpsExecutionModel == "delegated-ready" ? "Delegated" : "Assisted")
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("OPEN PERPS")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(brandPrimary)
                    Text("No open positions")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(openPerpDetail)
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.68))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.top, 16)
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
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                lockScreenLogo
                Spacer(minLength: 2)
                if #available(iOS 17.0, *) {
                    Button(intent: BremLogicWidgetRefreshIntent()) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 10, weight: .bold))
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Refresh BremLogic widget")
                }
            }

            Text(positionLabel)
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            HStack(spacing: 5) {
                Text("PnL \(pnlLabel)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                Spacer(minLength: 2)
                Text("Wallet \(walletLabel)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .lineLimit(1)
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
