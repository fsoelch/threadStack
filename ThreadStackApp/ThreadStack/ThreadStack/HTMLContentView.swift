import SwiftUI
import WebKit

// Rendert Wissensseiten-HTML vollständig (inkl. Tabellen & Bilder) — AttributedString(html:)
// unterstützt keine Tabellen, daher WKWebView mit dynamischer Höhenanpassung an den Inhalt.
struct HTMLContentView: View {
    let html: String
    @State private var height: CGFloat = 40

    var body: some View {
        HTMLWebView(html: html, height: $height)
            .frame(height: height)
    }
}

private func wrappedHTML(_ body: String) -> String {
    """
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { -webkit-touch-callout: none; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 16px;
        color: #111210; margin: 0; padding: 0; line-height: 1.55; word-wrap: break-word;
      }
      table { width:100%; border-collapse:collapse; margin-bottom:16px; font-size:14px; }
      th { text-align:left; padding:8px 10px; border:1px solid #E8E7E2; background:#F5F5F2; font-weight:700; }
      td { padding:8px 10px; border:1px solid #E8E7E2; }
      img { max-width: 100%; border-radius: 8px; height: auto; }
      a { color: #1D6FE8; }
      p { margin: 0 0 12px; }
    </style></head><body>\(body)</body></html>
    """
}

#if os(iOS)
private struct HTMLWebView: UIViewRepresentable {
    let html: String
    @Binding var height: CGFloat

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.navigationDelegate = context.coordinator
        web.scrollView.isScrollEnabled = false
        web.isOpaque = false
        web.backgroundColor = .clear
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {
        web.loadHTMLString(wrappedHTML(html), baseURL: nil)
    }
    func makeCoordinator() -> HTMLWebViewCoordinator { HTMLWebViewCoordinator(height: $height) }
}
#else
private struct HTMLWebView: NSViewRepresentable {
    let html: String
    @Binding var height: CGFloat

    func makeNSView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.navigationDelegate = context.coordinator
        return web
    }
    func updateNSView(_ web: WKWebView, context: Context) {
        web.loadHTMLString(wrappedHTML(html), baseURL: nil)
    }
    func makeCoordinator() -> HTMLWebViewCoordinator { HTMLWebViewCoordinator(height: $height) }
}
#endif

final class HTMLWebViewCoordinator: NSObject, WKNavigationDelegate {
    @Binding var height: CGFloat
    init(height: Binding<CGFloat>) { _height = height }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.body.scrollHeight") { [weak self] result, _ in
            guard let n = result as? NSNumber else { return }
            DispatchQueue.main.async { self?.height = CGFloat(truncating: n) }
        }
    }
}
