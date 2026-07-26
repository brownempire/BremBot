import SwiftUI
import ImageIO
import WidgetKit
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

#if canImport(WatchConnectivity)
final class BremLogicWatchConnectivityRelay: NSObject, WCSessionDelegate {
    static let shared = BremLogicWatchConnectivityRelay()
    private let stateQueue = DispatchQueue(label: "com.bremlogic.watch-connectivity")
    private var pendingPayload: [String: Any]?

    private override init() {
        super.init()
    }

    func activate() {
        stateQueue.async {
            self.activateSessionIfNeeded()
        }
    }

    func sendRefresh(snapshotTimestamp: Double) {
        guard snapshotTimestamp.isFinite else { return }
        let payload: [String: Any] = [
            "bremLogicSnapshotUpdatedAt": snapshotTimestamp,
            "bremLogicWatchRefresh": true,
        ]

        stateQueue.async {
            self.pendingPayload = payload
            self.activateSessionIfNeeded()
            self.deliverPendingPayloadIfPossible()
        }
    }

    private func activateSessionIfNeeded() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        if session.activationState != .activated {
            session.activate()
        }
    }

    private func deliverPendingPayloadIfPossible() {
        let session = WCSession.default
        guard session.activationState == .activated,
              let payload = pendingPayload
        else {
            return
        }

        // Application context preserves the newest refresh for background
        // delivery. The message path gives an immediate update when reachable.
        try? session.updateApplicationContext(payload)
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        }
        pendingPayload = nil
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated else { return }
        stateQueue.async {
            self.deliverPendingPayloadIfPossible()
        }
    }
}
#endif

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

private struct BremLogicWatchCandlestickChart: View {
    let candles: [BremLogicWatchCandle]
    let symbol: String
    let entryPrice: Double?
    let entryTimestamp: Double?
    let markPrice: Double?
    let takeProfitPrice: Double?
    let stopLossPrice: Double?
    let liquidationPrice: Double?

    private let upColor = Color(red: 0.035, green: 0.60, blue: 0.51)
    private let downColor = Color(red: 0.95, green: 0.21, blue: 0.27)
    private let entryColor = Color(red: 1.0, green: 0.72, blue: 0.24)
    private let markColor = Color(red: 0.36, green: 0.68, blue: 0.98)
    private let takeProfitColor = Color(red: 0.30, green: 0.89, blue: 0.54)
    private let stopLossColor = Color(red: 1.0, green: 0.45, blue: 0.45)
    private let liquidationColor = Color(red: 1.0, green: 0.58, blue: 0.22)

    private var visibleCandles: [BremLogicWatchCandle] {
        Array(candles.sorted { $0.timestamp < $1.timestamp }.suffix(60))
    }

    private var visibleEntryCandleIndex: Int? {
        bremLogicWatchEntryCandleIndex(
            candles: visibleCandles,
            entryTimestamp: entryTimestamp
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text("\(symbol) · 1m · 1h")
                    .font(.system(size: 8, weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 2)
                legend("E", entryPrice, entryColor)
                legend("M", markPrice, markColor)
                legend("TP", takeProfitPrice, takeProfitColor)
                legend("SL", stopLossPrice, stopLossColor)
                legend("L", liquidationPrice, liquidationColor)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.55)

            if visibleCandles.isEmpty {
                Text("Chart waiting for market data")
                    .font(.system(size: 9, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Canvas { context, size in
                    let plot = CGRect(x: 3, y: 3, width: max(1, size.width - 6), height: max(1, size.height - 6))
                    let candlePrices = visibleCandles.flatMap { [$0.low, $0.high] }
                    let levels = [entryPrice, markPrice, takeProfitPrice, stopLossPrice, liquidationPrice]
                        .compactMap { $0 }
                        .filter { $0.isFinite && $0 > 0 }
                    guard let rawMin = (candlePrices + levels).min(),
                          let rawMax = (candlePrices + levels).max()
                    else { return }
                    let rawRange = max(rawMax - rawMin, rawMax * 0.0005)
                    let minimum = rawMin - rawRange * 0.07
                    let maximum = rawMax + rawRange * 0.07
                    let range = max(maximum - minimum, 0.000_001)

                    func y(_ price: Double) -> CGFloat {
                        plot.maxY - CGFloat((price - minimum) / range) * plot.height
                    }

                    for index in 0...3 {
                        let lineY = plot.minY + CGFloat(index) * plot.height / 3
                        var grid = Path()
                        grid.move(to: CGPoint(x: plot.minX, y: lineY))
                        grid.addLine(to: CGPoint(x: plot.maxX, y: lineY))
                        context.stroke(grid, with: .color(.white.opacity(0.08)), lineWidth: 0.45)
                    }

                    let step = plot.width / CGFloat(max(visibleCandles.count, 1))
                    let bodyWidth = max(1, min(3, step * 0.62))
                    for (index, candle) in visibleCandles.enumerated() {
                        let x = plot.minX + (CGFloat(index) + 0.5) * step
                        let color = candle.close >= candle.open ? upColor : downColor
                        var wick = Path()
                        wick.move(to: CGPoint(x: x, y: y(candle.high)))
                        wick.addLine(to: CGPoint(x: x, y: y(candle.low)))
                        context.stroke(wick, with: .color(color), lineWidth: 0.65)

                        let openY = y(candle.open)
                        let closeY = y(candle.close)
                        var body = Path()
                        body.addRect(CGRect(
                            x: x - bodyWidth / 2,
                            y: min(openY, closeY),
                            width: bodyWidth,
                            height: max(1, abs(closeY - openY))
                        ))
                        context.fill(body, with: .color(color))
                    }

                    let referenceLines: [(Double?, Color, [CGFloat])] = [
                        (entryPrice, entryColor, [4, 2]),
                        (markPrice, markColor, []),
                        (takeProfitPrice, takeProfitColor, [2, 2]),
                        (stopLossPrice, stopLossColor, [3, 2]),
                        (liquidationPrice, liquidationColor, [6, 2]),
                    ]
                    for (price, color, dash) in referenceLines {
                        guard let price, price.isFinite, price > 0 else { continue }
                        var line = Path()
                        line.move(to: CGPoint(x: plot.minX, y: y(price)))
                        line.addLine(to: CGPoint(x: plot.maxX, y: y(price)))
                        context.stroke(line, with: .color(color.opacity(0.9)), style: StrokeStyle(lineWidth: 0.8, dash: dash))
                    }

                    if let entryPrice,
                       entryPrice.isFinite,
                       entryPrice > 0,
                       let entryIndex = visibleEntryCandleIndex {
                        let x = plot.minX + (CGFloat(entryIndex) + 0.5) * step
                        let center = CGPoint(x: x, y: y(entryPrice))
                        let markerSize = max(6, min(9, step * 1.5))
                        var marker = Path()
                        marker.addEllipse(in: CGRect(
                            x: center.x - markerSize / 2,
                            y: center.y - markerSize / 2,
                            width: markerSize,
                            height: markerSize
                        ))
                        context.fill(marker, with: .color(Color(red: 0.075, green: 0.09, blue: 0.13).opacity(0.82)))
                        context.stroke(marker, with: .color(entryColor), lineWidth: 1.5)
                    }
                }
            }
        }
        .padding(6)
        .frame(height: 132)
        .background(Color(red: 0.075, green: 0.09, blue: 0.13), in: RoundedRectangle(cornerRadius: 9))
        .overlay {
            RoundedRectangle(cornerRadius: 9).stroke(.white.opacity(0.09), lineWidth: 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(symbol) one minute chart showing the latest 60 candles")
    }

    @ViewBuilder
    private func legend(_ label: String, _ value: Double?, _ color: Color) -> some View {
        if let value, value.isFinite, value > 0 {
            HStack(spacing: 1) {
                Circle().fill(color).frame(width: 3, height: 3)
                Text("\(label) \(value >= 100 ? String(format: "%.1f", value) : String(format: "%.2f", value))")
                    .font(.system(size: 6, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct BremLogicWatchContentView: View {
    @Environment(\.scenePhase) private var scenePhase
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
                        metric("STOP LOSS", bremLogicPrice(snapshot.openPerpStopLossPrice), .red)
                        metric("SL P/L", bremLogicSignedUsd(snapshot.openPerpStopLossPnlUsd), .red)
                        metric("POSITION", bremLogicWalletUsd(snapshot.openPerpPositionValueUsd))
                        metric("COLLATERAL", bremLogicWalletUsd(snapshot.openPerpCollateralUsd))
                    }

                    BremLogicWatchCandlestickChart(
                        candles: snapshot.chartCandles ?? [],
                        symbol: snapshot.chartSymbol ?? snapshot.openPerpMarket ?? "PERP",
                        entryPrice: snapshot.openPerpEntryPrice,
                        entryTimestamp: snapshot.openPerpEntryTimestamp,
                        markPrice: snapshot.openPerpMarkPrice,
                        takeProfitPrice: snapshot.openPerpTakeProfitPrice,
                        stopLossPrice: snapshot.openPerpStopLossPrice,
                        liquidationPrice: snapshot.openPerpLiquidationPrice
                    )
                } else {
                    Text(snapshot.openPerpDetail ?? "The agent is monitoring for the next setup.")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 5)

                    metric("MARK", bremLogicPrice(snapshot.openPerpMarkPrice), Color(red: 0.36, green: 0.68, blue: 0.98))

                    BremLogicWatchCandlestickChart(
                        candles: snapshot.chartCandles ?? [],
                        symbol: snapshot.chartSymbol ?? "SOL",
                        entryPrice: nil,
                        entryTimestamp: nil,
                        markPrice: snapshot.openPerpMarkPrice,
                        takeProfitPrice: nil,
                        stopLossPrice: nil,
                        liquidationPrice: nil
                    )
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
        .onChange(of: scenePhase) { phase in
            guard phase == .active else { return }
            reloadComplications()
            Task { await reload() }
        }
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
            if snapshot.hasOpenPerp {
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
            reloadComplications()
#if canImport(WatchConnectivity)
            BremLogicWatchConnectivityRelay.shared.sendRefresh(
                snapshotTimestamp: next.updatedAt
            )
#endif
        }
        isLoading = false
    }

    private func reloadComplications() {
        WidgetCenter.shared.reloadTimelines(ofKind: "BremLogicWatchWidget")
        WidgetCenter.shared.reloadTimelines(ofKind: "BremLogicWalletWatchWidget")
        WidgetCenter.shared.reloadTimelines(ofKind: "BremLogicAgentWatchWidget")
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
