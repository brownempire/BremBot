import SwiftUI
import WidgetKit

struct BremLogicWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: BremLogicWidgetSnapshot
}

struct BremLogicWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> BremLogicWidgetEntry {
        BremLogicWidgetEntry(date: Date(), snapshot: .fallback)
    }

    func getSnapshot(in context: Context, completion: @escaping (BremLogicWidgetEntry) -> Void) {
        completion(BremLogicWidgetEntry(date: Date(), snapshot: BremLogicWidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BremLogicWidgetEntry>) -> Void) {
        let entry = BremLogicWidgetEntry(date: Date(), snapshot: BremLogicWidgetStore.load())
        let refreshDate = Date().addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(refreshDate)))
    }
}

struct BremLogicWidgetEntryView: View {
    let entry: BremLogicWidgetEntry

    private var confidenceLabel: String? {
        guard let confidence = entry.snapshot.latestSignalConfidence else { return nil }
        return String(format: "%.0f%% confidence", confidence * 100)
    }

    private var balanceLabel: String? {
        guard let balance = entry.snapshot.walletBalanceUsd else { return nil }
        return String(format: "$%.2f", balance)
    }

    private var updatedLabel: String {
        entry.date.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.07, green: 0.09, blue: 0.15),
                    Color(red: 0.03, green: 0.04, blue: 0.08),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(entry.snapshot.title)
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.9))
                        Text(entry.snapshot.latestSignalSymbol ?? "No live signal")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    if let direction = entry.snapshot.latestSignalDirection, !direction.isEmpty {
                        Text(direction.uppercased())
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.12))
                            .clipShape(Capsule())
                            .foregroundStyle(.white.opacity(0.95))
                    }
                }

                Text(entry.snapshot.latestSignalSummary ?? "Open the app to sync your latest signals.")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.82))
                    .lineLimit(3)

                Spacer(minLength: 0)

                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        if let confidenceLabel {
                            Text(confidenceLabel)
                                .font(.system(size: 11, weight: .semibold, design: .rounded))
                                .foregroundStyle(.mint)
                        }
                        if let balanceLabel {
                            Text("Wallet \(balanceLabel)")
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.75))
                        }
                    }
                    Spacer()
                    Text(updatedLabel)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
            .padding(14)
        }
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
        .description("Shows the latest BremLogic signal snapshot and wallet summary.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
