import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.2, *)
actor BremLogicLiveActivityCoordinator {
    static let shared = BremLogicLiveActivityCoordinator()
    private var scheduledRefreshTask: Task<Void, Never>?

    private func hasOpenPosition(_ snapshot: BremLogicWidgetSnapshot) -> Bool {
        let market = snapshot.openPerpMarket?.trimmingCharacters(in: .whitespacesAndNewlines)
        return market?.isEmpty == false
            || snapshot.openPerpPositionValueUsd != nil
            || snapshot.openPerpPnlUsd != nil
    }

    private func positionKey(for snapshot: BremLogicWidgetSnapshot) -> String {
        let market = snapshot.openPerpMarket?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased() ?? "PERPS"
        let side = snapshot.openPerpSide?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased() ?? "OPEN"
        return "\(market)-\(side)"
    }

    private func content(for snapshot: BremLogicWidgetSnapshot) -> ActivityContent<BremLogicTradeActivityAttributes.ContentState> {
        ActivityContent(
            state: BremLogicTradeActivityAttributes.ContentState(snapshot: snapshot),
            staleDate: Date().addingTimeInterval(BremLogicOpenPositionRefreshInterval + 60)
        )
    }

    func startScheduledRefresh() {
        guard scheduledRefreshTask == nil else { return }
        scheduledRefreshTask = Task {
            await refreshFromServer()
            while !Task.isCancelled {
                do {
                    try await Task.sleep(
                        nanoseconds: UInt64(BremLogicOpenPositionRefreshInterval * 1_000_000_000)
                    )
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                await refreshFromServer()
            }
        }
    }

    func refreshFromServer() async {
        do {
            let snapshot = try await BremLogicWidgetServerClient.fetch()
            try? BremLogicWidgetStore.save(snapshot)
            await reconcile(with: snapshot)
        } catch {
            if let cached = BremLogicWidgetStore.loadCached() {
                await reconcile(with: cached)
            }
        }
    }

    func reconcile(with snapshot: BremLogicWidgetSnapshot) async {
        let activities = Activity<BremLogicTradeActivityAttributes>.activities

        guard hasOpenPosition(snapshot) else {
            for activity in activities {
                await activity.end(nil, dismissalPolicy: .default)
            }
            return
        }

        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let key = positionKey(for: snapshot)
        let nextContent = content(for: snapshot)
        var matchingActivity: Activity<BremLogicTradeActivityAttributes>?

        for activity in activities {
            if activity.attributes.positionKey == key, matchingActivity == nil {
                matchingActivity = activity
            } else {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }

        if let matchingActivity {
            await matchingActivity.update(nextContent)
            return
        }

        do {
            _ = try Activity<BremLogicTradeActivityAttributes>.request(
                attributes: BremLogicTradeActivityAttributes(positionKey: key),
                content: nextContent,
                pushType: nil
            )
        } catch {
            // Live Activities are optional. Widget sync must remain functional
            // when the user disables them or the system declines a request.
        }
    }
}

enum BremLogicLiveActivityManager {
    static func startScheduledRefresh() {
        guard #available(iOS 16.2, *) else { return }
        Task {
            await BremLogicLiveActivityCoordinator.shared.startScheduledRefresh()
        }
    }

    static func refreshFromServer() {
        guard #available(iOS 16.2, *) else { return }
        Task {
            await BremLogicLiveActivityCoordinator.shared.refreshFromServer()
        }
    }

    static func reconcile(with snapshot: BremLogicWidgetSnapshot) {
        guard #available(iOS 16.2, *) else { return }
        Task {
            await BremLogicLiveActivityCoordinator.shared.reconcile(with: snapshot)
        }
    }
}
#else
enum BremLogicLiveActivityManager {
    static func startScheduledRefresh() {}
    static func refreshFromServer() {}
    static func reconcile(with snapshot: BremLogicWidgetSnapshot) {}
}
#endif
