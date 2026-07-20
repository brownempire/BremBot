import AppKit
import Combine
import SwiftUI
import WebKit

@MainActor
final class BremLogicMacBrowser: NSObject, ObservableObject {
    private static let homeURL = URL(string: "https://app.bremlogic.com/signals-bot")!

    @Published private(set) var isLoading = true
    @Published private(set) var estimatedProgress = 0.0
    @Published private(set) var blockingError: String?

    let webView: WKWebView
    private var observations: Set<AnyCancellable> = []

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) BremLogicMac/1.0"

        webView.publisher(for: \.estimatedProgress)
            .receive(on: RunLoop.main)
            .sink { [weak self] progress in self?.estimatedProgress = progress }
            .store(in: &observations)

        loadHome()
    }

    func reload() {
        blockingError = nil
        if webView.url == nil {
            loadHome()
        } else {
            webView.reload()
        }
    }

    private func loadHome() {
        webView.load(URLRequest(url: Self.homeURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    private func handleFailure(_ error: Error) {
        isLoading = false
        guard webView.url == nil else { return }
        blockingError = error.localizedDescription
    }
}

extension BremLogicMacBrowser: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
        blockingError = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        blockingError = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        let scheme = url.scheme?.lowercased()
        if scheme != "http" && scheme != "https" && scheme != "about" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.allow)
    }
}

extension BremLogicMacBrowser: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        let sensitivePrompt = prompt.localizedCaseInsensitiveContains("private key")
            || prompt.localizedCaseInsensitiveContains("password")
        let input: NSTextField = sensitivePrompt
            ? NSSecureTextField(string: defaultText ?? "")
            : NSTextField(string: defaultText ?? "")
        input.placeholderString = sensitivePrompt ? "Secure entry" : nil
        input.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        alert.accessoryView = input

        let finish: (NSApplication.ModalResponse) -> Void = { response in
            completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
        }

        if let window = webView.window {
            alert.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(alert.runModal())
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard navigationAction.targetFrame == nil, let url = navigationAction.request.url else { return nil }

        if url.host?.hasSuffix("bremlogic.com") == true {
            webView.load(navigationAction.request)
        } else {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

struct BremLogicMacWebView: NSViewRepresentable {
    let browser: BremLogicMacBrowser

    func makeNSView(context: Context) -> WKWebView {
        browser.webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}
}
