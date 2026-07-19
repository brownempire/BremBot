import AppKit
import SwiftUI

@main
struct BremLogicMacApp: App {
    @StateObject private var browser = BremLogicMacBrowser()

    var body: some Scene {
        WindowGroup("BremLogic") {
            BremLogicMacContentView(browser: browser)
                .frame(minWidth: 860, minHeight: 620)
        }
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("About BremLogic") {
                    NSApplication.shared.orderFrontStandardAboutPanel()
                }
            }
            CommandGroup(after: .toolbar) {
                Button("Reload BremLogic") {
                    browser.reload()
                }
                .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}
