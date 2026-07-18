import SwiftUI

struct BremLogicWatchContentView: View {
    @State private var snapshot = BremLogicWatchSnapshot.fallback
    @State private var isLoading = true

    private var pnlColor: Color {
        guard let pnl = snapshot.openPerpPnlUsd else { return .secondary }
        return pnl >= 0 ? Color(red: 0.45, green: 0.92, blue: 0.62) : Color(red: 1, green: 0.45, blue: 0.45)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("B")
                        .font(.system(size: 21, weight: .black, design: .rounded))
                        .foregroundStyle(Color(red: 0.57, green: 0.94, blue: 0.78))
                    Text("BREMLOGIC")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                    Spacer()
                    if isLoading {
                        ProgressView().controlSize(.mini)
                    }
                }

                Text(snapshot.hasOpenPerp ? (snapshot.openPerpLabel ?? "Open Perp") : "No open perps")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .lineLimit(2)

                if snapshot.hasOpenPerp {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("UNREALIZED P/L")
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                        Text(bremLogicSignedUsd(snapshot.openPerpPnlUsd))
                            .font(.system(size: 24, weight: .bold, design: .rounded))
                            .foregroundStyle(pnlColor)
                    }

                    HStack(spacing: 8) {
                        watchMetric("TP P/L", bremLogicSignedUsd(snapshot.openPerpTakeProfitPnlUsd), .green)
                        watchMetric("SL P/L", bremLogicSignedUsd(snapshot.openPerpStopLossPnlUsd), .red)
                    }
                } else {
                    Text("The agent is monitoring for the next setup.")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                }

                watchMetric(
                    "AGENT WALLET",
                    bremLogicWalletUsd(snapshot.agentWalletBalanceUsd ?? snapshot.walletBalanceUsd),
                    .primary
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
        }
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func watchMetric(_ title: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 8, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    @MainActor
    private func reload() async {
        isLoading = true
        if let next = try? await BremLogicWatchServerClient.fetch() {
            snapshot = next
        }
        isLoading = false
    }
}
