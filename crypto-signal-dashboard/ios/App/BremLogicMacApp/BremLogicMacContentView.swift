import SwiftUI

struct BremLogicMacContentView: View {
    @ObservedObject var browser: BremLogicMacBrowser

    var body: some View {
        ZStack {
            Color(red: 0.025, green: 0.035, blue: 0.06)
                .ignoresSafeArea()

            BremLogicMacWebView(browser: browser)

            if let message = browser.blockingError {
                VStack(spacing: 14) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 30, weight: .medium))
                        .foregroundStyle(Color(red: 0.45, green: 0.92, blue: 0.72))
                    Text("BremLogic could not connect")
                        .font(.title3.weight(.semibold))
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 420)
                    Button("Try Again") {
                        browser.reload()
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding(30)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
            }
        }
        .overlay(alignment: .top) {
            if browser.isLoading {
                ProgressView(value: browser.estimatedProgress)
                    .progressViewStyle(.linear)
                    .tint(Color(red: 0.45, green: 0.92, blue: 0.72))
            }
        }
    }
}
