import SwiftUI
import WidgetKit

struct BremLogicWatchEntry: TimelineEntry {
    let date: Date
    let snapshot: BremLogicWatchSnapshot
}

struct BremLogicWatchProvider: TimelineProvider {
    func placeholder(in context: Context) -> BremLogicWatchEntry {
        BremLogicWatchEntry(date: Date(), snapshot: .fallback)
    }

    func getSnapshot(in context: Context, completion: @escaping (BremLogicWatchEntry) -> Void) {
        guard !context.isPreview else {
            completion(BremLogicWatchEntry(date: Date(), snapshot: .fallback))
            return
        }
        Task {
            let snapshot = (try? await BremLogicWatchServerClient.fetch()) ?? .fallback
            completion(BremLogicWatchEntry(date: Date(), snapshot: snapshot))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BremLogicWatchEntry>) -> Void) {
        Task {
            let snapshot = (try? await BremLogicWatchServerClient.fetch()) ?? .fallback
            let refreshInterval: TimeInterval = snapshot.hasOpenPerp ? 5 * 60 : 15 * 60
            let entry = BremLogicWatchEntry(date: Date(), snapshot: snapshot)
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(refreshInterval))))
        }
    }
}

struct BremLogicWatchWidgetView: View {
    let entry: BremLogicWatchEntry
    @Environment(\.widgetFamily) private var family

    private var market: String {
        entry.snapshot.openPerpMarket ?? "PERPS"
    }

    private var pnl: String {
        bremLogicSignedUsd(entry.snapshot.openPerpPnlUsd)
    }

    private var pnlColor: Color {
        guard let value = entry.snapshot.openPerpPnlUsd else { return .secondary }
        return value >= 0 ? Color(red: 0.45, green: 0.92, blue: 0.62) : Color(red: 1, green: 0.45, blue: 0.45)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular:
            VStack(spacing: 0) {
                Text(market)
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Text(pnl)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(pnlColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
            }
        case .accessoryCorner:
            Text(pnl)
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(pnlColor)
                .widgetLabel { Text(market) }
        case .accessoryInline:
            Text("BremLogic \(market) \(pnl)")
        default:
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("BREMLOGIC")
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Spacer()
                    Text(entry.snapshot.perpsSessionState ?? "Clocked Out")
                        .font(.system(size: 8, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Text(entry.snapshot.hasOpenPerp ? (entry.snapshot.openPerpLabel ?? market) : "No open perps")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .lineLimit(1)
                HStack {
                    Text("P/L \(pnl)").foregroundStyle(pnlColor)
                    Spacer()
                    Text(bremLogicWalletUsd(entry.snapshot.agentWalletBalanceUsd ?? entry.snapshot.walletBalanceUsd))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }
                .font(.system(size: 10, weight: .bold, design: .rounded))
            }
        }
    }

    var body: some View {
        content.containerBackground(.clear, for: .widget)
    }
}

struct BremLogicWatchWidget: Widget {
    let kind = "BremLogicWatchWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWatchProvider()) { entry in
            BremLogicWatchWidgetView(entry: entry)
        }
        .configurationDisplayName("BremLogic Perps")
        .description("Shows your open Perps position, P/L, and agent wallet on Apple Watch.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}
