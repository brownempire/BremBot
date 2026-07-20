import SwiftUI
import WidgetKit
import ImageIO

private struct BremLogicOfficialLogo: View {
    let width: CGFloat
    let height: CGFloat

    private static let image: CGImage? = {
        guard let url = Bundle.main.url(forResource: "BremLogicLogo", withExtension: "png"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            return nil
        }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }()

    var body: some View {
        if let image = Self.image {
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: width, height: height, alignment: .leading)
        }
    }
}

struct BremLogicWatchEntry: TimelineEntry {
    let date: Date
    let snapshot: BremLogicWatchSnapshot
}

struct BremLogicWatchProvider: TimelineProvider {
    private static let cacheKey = "BremLogicWatchWidgetSnapshot"

    private func cachedSnapshot() -> BremLogicWatchSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: Self.cacheKey) else { return nil }
        return try? JSONDecoder().decode(BremLogicWatchSnapshot.self, from: data)
    }

    private func cache(_ snapshot: BremLogicWatchSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: Self.cacheKey)
    }

    /// WidgetKit may terminate a watch complication extension that waits too
    /// long for its first timeline. Race the request against a short deadline
    /// and always give the system a usable cached or fallback entry.
    private func loadTimelineSnapshot() async -> BremLogicWatchSnapshot {
        let fallback = cachedSnapshot() ?? .fallback

        return await withTaskGroup(of: BremLogicWatchSnapshot?.self) { group in
            group.addTask {
                try? await BremLogicWatchServerClient.fetch(timeoutInterval: 3)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                return nil
            }

            let result = await group.next() ?? nil
            group.cancelAll()

            if let result {
                cache(result)
                return result
            }
            return fallback
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
        Task {
            let snapshot = await loadTimelineSnapshot()
            completion(BremLogicWatchEntry(date: Date(), snapshot: snapshot))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BremLogicWatchEntry>) -> Void) {
        Task {
            let snapshot = await loadTimelineSnapshot()
            let refreshInterval: TimeInterval = snapshot.hasOpenPerp ? 5 * 60 : 15 * 60
            completion(Timeline(
                entries: [BremLogicWatchEntry(date: Date(), snapshot: snapshot)],
                policy: .after(Date().addingTimeInterval(refreshInterval))
            ))
        }
    }
}

struct BremLogicComplicationBrand: View {
    var compact = false

    var body: some View {
        BremLogicOfficialLogo(
            width: compact ? 34 : 46,
            height: compact ? 11 : 15
        )
    }
}

struct BremLogicPositionComplicationView: View {
    let entry: BremLogicWatchEntry
    @Environment(\.widgetFamily) private var family

    private var snapshot: BremLogicWatchSnapshot { entry.snapshot }
    private var market: String { snapshot.openPerpMarket ?? "PERPS" }
    private var pnl: String { bremLogicSignedUsd(snapshot.openPerpPnlUsd) }
    private var pnlColor: Color {
        guard let value = snapshot.openPerpPnlUsd else { return .secondary }
        return value >= 0 ? Color(red: 0.45, green: 0.92, blue: 0.62) : Color(red: 1, green: 0.45, blue: 0.45)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular:
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
        case .accessoryCorner:
            Text(pnl)
                .font(.system(size: 13, weight: .black, design: .rounded))
                .foregroundStyle(pnlColor)
                .widgetLabel { Text("B \(market)") }
        case .accessoryInline:
            Text("B \(snapshot.openPerpLabel ?? market) \(pnl) \(bremLogicPercent(snapshot.openPerpPnlPercent))")
        default:
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 3) {
                    BremLogicComplicationBrand()
                    Spacer(minLength: 2)
                    Circle()
                        .fill(snapshot.perpsSessionState == "Clocked In" ? Color.green : Color.secondary)
                        .frame(width: 4, height: 4)
                    Text(snapshot.perpsSessionState == "Clocked In" ? "LIVE" : "IDLE")
                        .font(.system(size: 6.5, weight: .bold, design: .rounded))
                        .foregroundStyle(.secondary)
                }
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(snapshot.hasOpenPerp ? (snapshot.openPerpLabel ?? market) : "AGENT MONITORING")
                        .font(.system(size: 11, weight: .black, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Spacer(minLength: 2)
                    Text(pnl)
                        .font(.system(size: 11, weight: .black, design: .rounded))
                        .foregroundStyle(pnlColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.55)
                }
                if snapshot.hasOpenPerp {
                    HStack(spacing: 3) {
                        Text(bremLogicPercent(snapshot.openPerpPnlPercent)).foregroundStyle(pnlColor)
                        Text("•")
                        Text(bremLogicLeverage(snapshot.openPerpLeverage))
                        Text("•")
                        Text("TP \(bremLogicPrice(snapshot.openPerpTakeProfitPrice))")
                    }
                    .font(.system(size: 7.5, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                } else {
                    Text("Wallet \(bremLogicWalletUsd(snapshot.agentWalletBalanceUsd ?? snapshot.walletBalanceUsd))")
                        .font(.system(size: 8, weight: .bold, design: .rounded))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    var body: some View {
        content
            .containerBackground(.clear, for: .widget)
            // Without an explicit privacy declaration, watchOS renders the
            // entire complication as a placeholder while Always On is active.
            .privacySensitive(false)
            .unredacted()
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
        .containerBackground(.clear, for: .widget)
        .privacySensitive(false)
        .unredacted()
    }
}

struct BremLogicAgentComplicationView: View {
    let entry: BremLogicWatchEntry
    @Environment(\.widgetFamily) private var family
    private var clockedIn: Bool { entry.snapshot.perpsSessionState == "Clocked In" }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Text("B Agent \(clockedIn ? "Clocked In" : "Clocked Out")")
            case .accessoryCorner:
                Text(clockedIn ? "ON" : "OFF")
                    .font(.system(size: 14, weight: .black, design: .rounded))
                    .foregroundStyle(clockedIn ? .green : .secondary)
                    .widgetLabel { Text("B AGENT") }
            default:
                VStack(spacing: 1) {
                    BremLogicComplicationBrand(compact: true)
                    Image(systemName: clockedIn ? "bolt.fill" : "pause.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(clockedIn ? .green : .secondary)
                    Text(clockedIn ? "ACTIVE" : "IDLE")
                        .font(.system(size: 6, weight: .bold, design: .rounded))
                }
            }
        }
        .containerBackground(.clear, for: .widget)
        .privacySensitive(false)
        .unredacted()
    }
}

struct BremLogicWatchWidget: Widget {
    let kind = "BremLogicWatchWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWatchProvider()) { entry in
            BremLogicPositionComplicationView(entry: entry)
        }
        .configurationDisplayName("BremLogic Position")
        .description("Dense open-position status with P/L, leverage, TP, and BremLogic branding.")
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
    let kind = "BremLogicAgentWatchWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BremLogicWatchProvider()) { entry in
            BremLogicAgentComplicationView(entry: entry)
        }
        .configurationDisplayName("BremLogic Agent")
        .description("Shows whether the Perps agent is clocked in and active.")
        .supportedFamilies([.accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}
