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
    @Environment(\.widgetFamily) private var family

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
                .frame(width: family == .systemSmall ? 66 : family == .systemMedium ? 92 : 112, height: 30, alignment: .leading)
        } else {
            Text("BremLogic")
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    private func metric(_ title: String, _ value: String, color: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.5))
                .lineLimit(1)
            Text(value)
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(Color.white.opacity(0.065), lineWidth: 1)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            logo
                .layoutPriority(0)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(entry.snapshot.perpsSessionState == "Clocked In" ? mint : .white.opacity(0.65))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text("Updated \(updatedLabel)")
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .layoutPriority(2)
        }
        .frame(maxWidth: .infinity)
    }

    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            header
            Text("OPEN PERPS")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(mint)
            Text(positionLabel)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(detailLabel)
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.7))
                .lineLimit(1)
            if hasOpenPerp {
                Text(usd(entry.snapshot.openPerpPnlUsd, signed: true))
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(pnlColor)
            }
            Spacer(minLength: 0)
            HStack(spacing: 7) {
                metric("Main", usd(entry.snapshot.mainWalletBalanceUsd))
                metric("Agent", usd(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
                refreshButton
            }
        }
    }

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 11) {
            header

            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("OPEN PERPS")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(mint)
                    Text(positionLabel)
                        .font(.system(size: family == .systemExtraLarge ? 30 : 25, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(detailLabel)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.68))
                        .lineLimit(2)
                    Spacer(minLength: 3)
                    Text("UNREALIZED PNL")
                        .font(.system(size: 9, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.5))
                    Text(usd(entry.snapshot.openPerpPnlUsd, signed: true))
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(pnlColor)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(12)
                .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 7), count: 4), spacing: 7) {
                    metric("Position", usd(entry.snapshot.openPerpPositionValueUsd))
                    metric("Collateral", usd(entry.snapshot.openPerpCollateralUsd))
                    metric("Entry", price(entry.snapshot.openPerpEntryPrice))
                    metric("Mark", price(entry.snapshot.openPerpMarkPrice))
                    metric("Leverage", leverage(entry.snapshot.openPerpLeverage))
                    metric("Liquidation", price(entry.snapshot.openPerpLiquidationPrice), color: .orange)
                    metric("Take Profit", price(entry.snapshot.openPerpTakeProfitPrice), color: mint)
                    metric("Stop Loss", price(entry.snapshot.openPerpStopLossPrice), color: negative)
                    metric("TP P/L", usd(entry.snapshot.openPerpTakeProfitPnlUsd, signed: true), color: positive)
                    metric("SL P/L", usd(entry.snapshot.openPerpStopLossPnlUsd, signed: true), color: negative)
                    metric("Mode", entry.snapshot.perpsMode ?? "Paper")
                    metric("Execution", entry.snapshot.perpsExecutionModel == "delegated-ready" ? "Delegated" : "Assisted")
                }
                .frame(maxWidth: .infinity, alignment: .top)
            }

            HStack(spacing: 8) {
                metric("Main Wallet", usd(entry.snapshot.mainWalletBalanceUsd))
                metric("Agent Wallet", usd(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
                refreshButton
            }
            .padding(.top, 8)
            .overlay(alignment: .top) {
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
            }
        }
    }

    private var refreshButton: some View {
        Button(intent: BremLogicMacWidgetRefreshIntent()) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(mint)
                .frame(width: 40, height: 42)
                .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh BremLogic widget")
    }

    var body: some View {
        Group {
            if family == .systemLarge || family == .systemExtraLarge {
                expandedContent
            } else {
                compactContent
            }
        }
        .padding(family == .systemExtraLarge ? 16 : 12)
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
