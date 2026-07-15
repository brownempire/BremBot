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

    private var brandPrimary: Color {
        Color(red: 0.57, green: 0.94, blue: 0.78)
    }

    private var confidenceLabel: String? {
        guard let confidence = entry.snapshot.latestSignalConfidence else { return nil }
        return String(format: "%.0f%% confidence", confidence * 100)
    }

    private var balanceLabel: String? {
        guard let balance = entry.snapshot.walletBalanceUsd else { return nil }
        return String(format: "$%.2f", balance)
    }

    private var sessionLabel: String? {
        guard let state = entry.snapshot.perpsSessionState, !state.isEmpty else { return nil }
        let mode = entry.snapshot.perpsMode?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let mode, !mode.isEmpty {
            return "\(state) · \(mode)"
        }
        return state
    }

    private var executionLabel: String? {
        guard let model = entry.snapshot.perpsExecutionModel?.trimmingCharacters(in: .whitespacesAndNewlines),
              !model.isEmpty else { return nil }
        return "Perps \(model)"
    }

    private var signalSymbolLabel: String {
        entry.snapshot.latestSignalSymbol ?? "No live signal"
    }

    private var updatedLabel: String {
        Date(timeIntervalSince1970: entry.snapshot.updatedAt).formatted(date: .omitted, time: .shortened)
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

    var body: some View {
        applyWidgetBackground(
            to: VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .center, spacing: 10) {
                    ZStack {
                        Circle()
                            .fill(brandPrimary.opacity(0.16))
                            .frame(width: 28, height: 28)
                        Text("BL")
                            .font(.system(size: 11, weight: .black, design: .rounded))
                            .foregroundStyle(brandPrimary)
                    }

                    VStack(alignment: .leading, spacing: 1) {
                        Text("BremLogic")
                            .font(.system(size: 13, weight: .heavy, design: .rounded))
                            .foregroundStyle(.white)
                        Text("Signals Widget")
                            .font(.system(size: 10, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.62))
                    }

                    Spacer()

                    if let balanceLabel {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("Wallet")
                                .font(.system(size: 9, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.58))
                            Text(balanceLabel)
                                .font(.system(size: 14, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                        }
                    }
                }

                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(signalSymbolLabel)
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                        Text(entry.snapshot.latestSignalSummary ?? "Open the app to sync your latest signals.")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.82))
                            .lineLimit(3)
                    }
                    Spacer()
                    if let direction = entry.snapshot.latestSignalDirection, !direction.isEmpty {
                        Text(direction.uppercased())
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(brandPrimary.opacity(0.18))
                            .clipShape(Capsule())
                            .foregroundStyle(.white.opacity(0.95))
                    }
                }

                Spacer(minLength: 0)

                HStack(alignment: .bottom, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        if let confidenceLabel {
                            Text(confidenceLabel)
                                .font(.system(size: 11, weight: .semibold, design: .rounded))
                                .foregroundStyle(brandPrimary)
                        }
                        if let sessionLabel {
                            Text(sessionLabel)
                                .font(.system(size: 10, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.76))
                                .lineLimit(1)
                        }
                        if let executionLabel {
                            Text(executionLabel)
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.64))
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    if balanceLabel == nil {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("Wallet")
                                .font(.system(size: 9, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.58))
                            Text("Sync app")
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                                .foregroundStyle(.white.opacity(0.9))
                        }
                    }
                    Text(updatedLabel)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
        )
        .padding(14)
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
