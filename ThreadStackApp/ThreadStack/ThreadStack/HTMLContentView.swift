import SwiftUI
import WebKit

#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Read-only renderer for server-sanitized-but-still-formatted HTML content
/// (e.g. knowledge pages). Hardened per security requirement:
///
/// 1. JavaScript execution is disabled (`WKWebpagePreferences.allowsContentJavaScript = false`).
/// 2. Height on iOS is measured via KVO on `webView.scrollView.contentSize`,
///    NOT via `evaluateJavaScript("document.body.scrollHeight")` — that
///    approach silently stopped working the moment JS was disabled anyway.
/// 3. A restrictive CSP meta tag is injected into the HTML wrapper:
///    `default-src 'none'; img-src data: https:; style-src 'unsafe-inline'`.
/// 4. `decidePolicyFor navigationAction` rejects every navigation except the
///    initial `loadHTMLString` call; http(s) links are instead opened in the
///    system browser so the user never leaves the app's WKWebView sandbox.
struct HTMLContentView: View {
    let html: String

    @State private var measuredHeight: CGFloat = 160

    var body: some View {
        #if os(iOS)
        HTMLContentRepresentable_iOS(html: wrappedHTML, measuredHeight: $measuredHeight)
            .frame(height: measuredHeight)
        #else
        HTMLContentRepresentable_macOS(html: wrappedHTML)
            .frame(minHeight: 320)
        #endif
    }

    /// Wraps the caller-provided (already server-sanitized) HTML fragment
    /// with a minimal document + CSP meta tag. Does not itself perform
    /// sanitization — that is the server's responsibility per the security
    /// baseline (validate/sanitize at the trust boundary, not client-side).
    private var wrappedHTML: String {
        """
        <!DOCTYPE html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'">
        <style>
        body { font-family: -apple-system, sans-serif; margin: 8px; color: #1c1c1e; word-wrap: break-word; }
        img { max-width: 100%; height: auto; }
        a { color: #1D6FE8; }
        </style>
        </head>
        <body>\(html)</body>
        </html>
        """
    }
}

// MARK: - Shared navigation policy

/// Shared `WKNavigationDelegate` behavior: allow exactly the first
/// (programmatic `loadHTMLString`) navigation, reject everything else, and
/// route http(s) link taps to the system browser.
final class HTMLContentNavigationDelegate: NSObject, WKNavigationDelegate {
    private var didAllowInitialLoad = false

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if !didAllowInitialLoad {
            didAllowInitialLoad = true
            decisionHandler(.allow)
            return
        }
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
            #if os(iOS)
            UIApplication.shared.open(url)
            #else
            NSWorkspace.shared.open(url)
            #endif
        }
        decisionHandler(.cancel)
    }
}

private func makeHardenedConfiguration() -> WKWebViewConfiguration {
    let config = WKWebViewConfiguration()
    let prefs = WKWebpagePreferences()
    prefs.allowsContentJavaScript = false
    config.defaultWebpagePreferences = prefs
    return config
}

// MARK: - iOS

#if os(iOS)
private struct HTMLContentRepresentable_iOS: UIViewRepresentable {
    let html: String
    @Binding var measuredHeight: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(delegate: HTMLContentNavigationDelegate(), measuredHeight: $measuredHeight)
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: makeHardenedConfiguration())
        webView.navigationDelegate = context.coordinator.delegate
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        context.coordinator.observe(webView)
        webView.loadHTMLString(html, baseURL: nil)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Content is fixed per node — no dynamic re-load needed after creation.
    }

    final class Coordinator {
        let delegate: HTMLContentNavigationDelegate
        @Binding var measuredHeight: CGFloat
        private var observation: NSKeyValueObservation?

        init(delegate: HTMLContentNavigationDelegate, measuredHeight: Binding<CGFloat>) {
            self.delegate = delegate
            self._measuredHeight = measuredHeight
        }

        func observe(_ webView: WKWebView) {
            observation = webView.scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, change in
                guard let height = change.newValue?.height, height > 0 else { return }
                DispatchQueue.main.async { self?.measuredHeight = height }
            }
        }
    }
}
#endif

// MARK: - macOS

#if os(macOS)
private struct HTMLContentRepresentable_macOS: NSViewRepresentable {
    let html: String

    func makeCoordinator() -> HTMLContentNavigationDelegate { HTMLContentNavigationDelegate() }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: makeHardenedConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.loadHTMLString(html, baseURL: nil)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Content is fixed per node — no dynamic re-load needed after creation.
        // Note: unlike iOS, AppKit's WKWebView has no `scrollView` KVO path for
        // content-size measurement; it scrolls its own content internally, so
        // the view is presented with a fixed minimum height instead of a
        // dynamically measured one (documented platform difference).
    }
}
#endif
