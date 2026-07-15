import SwiftUI
import UIKit
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

    private var balanceLabel: String? {
        guard let balance = entry.snapshot.walletBalanceUsd else { return nil }
        return String(format: "$%.2f", balance)
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

    @ViewBuilder
    private var brandLogo: some View {
        if let image = UIImage(named: "BremLogicLogo")
            ?? BremLogicWidgetAssetLoader.logoImage() {
            Image(uiImage: image)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 116, height: 38, alignment: .leading)
        } else {
            Text("BremLogic")
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    var body: some View {
        applyWidgetBackground(
            to: VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    brandLogo
                    Spacer()
                    Text(updatedLabel)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.58))
                }

                VStack(alignment: .leading, spacing: 7) {
                    Text("Open Perps")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(brandPrimary)
                        .textCase(.uppercase)
                    Text(openPerpLabel)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(openPerpDetail)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.78))
                        .lineLimit(2)
                    if let pnlLabel {
                        Text([pnlLabel, pnlPercentLabel].compactMap { $0 }.joined(separator: "  •  "))
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .foregroundStyle(pnlColor)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 0)

                HStack(alignment: .center, spacing: 8) {
                    Text("Wallet Value")
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.62))
                    Spacer()
                    HStack(spacing: 10) {
                        Text(balanceLabel ?? "Open app to sync")
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                        if #available(iOS 17.0, *) {
                            Button(intent: BremLogicWidgetRefreshIntent()) {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: 13, weight: .bold, design: .rounded))
                                    .foregroundStyle(brandPrimary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.top, 8)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(Color.white.opacity(0.08))
                        .frame(height: 1)
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

enum BremLogicWidgetAssetLoader {
    static func logoImage() -> UIImage? {
        guard let path = Bundle.main.path(forResource: "BremLogicLogo", ofType: "png") else {
            return nil
        }

        return UIImage(contentsOfFile: path)
    }
}
