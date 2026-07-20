import SwiftUI
import ImageIO
import WidgetKit

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

struct BremLogicWatchContentView: View {
    @State private var snapshot = BremLogicWatchSnapshot.fallback
    @State private var isLoading = true

    private let metricColumns = [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)]

    private var pnlColor: Color {
        guard let pnl = snapshot.openPerpPnlUsd else { return .secondary }
        return pnl >= 0 ? Color(red: 0.45, green: 0.92, blue: 0.62) : Color(red: 1, green: 0.45, blue: 0.45)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                brandedHeader
                positionHero

                if snapshot.hasOpenPerp {
                    LazyVGrid(columns: metricColumns, spacing: 6) {
                        metric("ENTRY", bremLogicPrice(snapshot.openPerpEntryPrice))
                        metric("MARK", bremLogicPrice(snapshot.openPerpMarkPrice))
                        metric("LEVERAGE", bremLogicLeverage(snapshot.openPerpLeverage))
                        metric("LIQUIDATION", bremLogicPrice(snapshot.openPerpLiquidationPrice), .orange)
                        metric("TAKE PROFIT", bremLogicPrice(snapshot.openPerpTakeProfitPrice), .green)
                        metric("TP P/L", bremLogicSignedUsd(snapshot.openPerpTakeProfitPnlUsd), .green)
                        metric("POSITION", bremLogicWalletUsd(snapshot.openPerpPositionValueUsd))
                        metric("COLLATERAL", bremLogicWalletUsd(snapshot.openPerpCollateralUsd))
                    }
                } else {
                    Text(snapshot.openPerpDetail ?? "The agent is monitoring for the next setup.")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 5)
                }

                HStack(spacing: 6) {
                    metric("AGENT WALLET", bremLogicWalletUsd(snapshot.agentWalletBalanceUsd ?? snapshot.walletBalanceUsd))
                    metric("UPDATED", Date(timeIntervalSince1970: snapshot.updatedAt).formatted(date: .omitted, time: .shortened))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 3)
            .padding(.bottom, 6)
        }
        .task { await runRefreshLoop() }
        .refreshable { await reload() }
    }

    private var brandedHeader: some View {
        HStack(alignment: .top, spacing: 4) {
            BremLogicOfficialLogo(width: 78, height: 25)
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 3) {
                    Circle()
                        .fill(snapshot.perpsSessionState == "Clocked In" ? Color.green : Color.secondary)
                        .frame(width: 6, height: 6)
                    Text(snapshot.perpsSessionState == "Clocked In" ? "LIVE" : "IDLE")
                        .font(.system(size: 7, weight: .bold, design: .rounded))
                        .foregroundStyle(.secondary)
                }

                Button {
                    Task { await reload() }
                } label: {
                    Group {
                        if isLoading {
                            ProgressView()
                                .controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 10, weight: .bold))
                        }
                    }
                    .frame(width: 24, height: 20)
                    .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
                .accessibilityLabel("Refresh BremLogic")
                .accessibilityHint("Fetches the latest position and wallet information")
            }
        }
    }

    private var positionHero: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(snapshot.hasOpenPerp ? (snapshot.openPerpLabel ?? "OPEN PERP") : "NO OPEN PERPS")
                .font(.system(size: 16, weight: .black, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(bremLogicSignedUsd(snapshot.openPerpPnlUsd))
                    .font(.system(size: 25, weight: .black, design: .rounded))
                    .foregroundStyle(pnlColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Text(bremLogicPercent(snapshot.openPerpPnlPercent))
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(pnlColor)
                    .lineLimit(1)
            }
        }
    }

    private func metric(_ title: String, _ value: String, _ color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.system(size: 7, weight: .bold, design: .rounded))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(value)
                .font(.system(size: 11, weight: .black, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 7)
        .padding(.vertical, 6)
        .background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @MainActor
    private func reload() async {
        isLoading = true
        if ProcessInfo.processInfo.arguments.contains("-BremLogicPreview") {
            snapshot = .previewPosition
        } else if let next = try? await BremLogicWatchServerClient.fetch() {
            snapshot = next
            WidgetCenter.shared.reloadAllTimelines()
        }
        isLoading = false
    }

    @MainActor
    private func runRefreshLoop() async {
        await reload()

        while !Task.isCancelled {
            let interval = BremLogicWatchRefreshPolicy.interval(for: snapshot)
            do {
                try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            } catch {
                return
            }
            await reload()
        }
    }
}
