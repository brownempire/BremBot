import WidgetKit
import SwiftUI

@main
struct BremLogicWidgetBundle: WidgetBundle {
    var body: some Widget {
        BremLogicWidget()
        if #available(iOS 16.1, *) {
            BremLogicLockScreenWidget()
        }
    }
}
