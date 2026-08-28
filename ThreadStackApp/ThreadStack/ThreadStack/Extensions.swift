import SwiftUI

// MARK: - Font scaling

let fontScales: [CGFloat] = [0.75, 0.85, 0.92, 1.0, 1.1, 1.22, 1.4]

struct FontScaleKey: EnvironmentKey {
    static let defaultValue: CGFloat = 1.0
}

extension EnvironmentValues {
    var fontScale: CGFloat {
        get { self[FontScaleKey.self] }
        set { self[FontScaleKey.self] = newValue }
    }
}

private struct ScaledFontModifier: ViewModifier {
    @Environment(\.fontScale) private var scale
    let style: Font.TextStyle

    func body(content: Content) -> some View {
        #if os(macOS)
        content.font(.system(size: macBaseSize(style) * scale))
        #else
        content.font(iOSFont(style))
        #endif
    }
}

#if os(macOS)
private func macBaseSize(_ style: Font.TextStyle) -> CGFloat {
    switch style {
    case .largeTitle:    return 34
    case .title:         return 28
    case .title2:        return 22
    case .title3:        return 20
    case .headline:      return 17
    case .subheadline:   return 15
    case .body:          return 17
    case .callout:       return 16
    case .footnote:      return 13
    case .caption:       return 12
    case .caption2:      return 11
    @unknown default:    return 13
    }
}
#endif

#if os(iOS)
private func iOSFont(_ style: Font.TextStyle) -> Font {
    switch style {
    case .largeTitle:    return .largeTitle
    case .title:         return .title
    case .title2:        return .title2
    case .title3:        return .title3
    case .headline:      return .headline
    case .subheadline:   return .subheadline
    case .body:          return .body
    case .callout:       return .callout
    case .footnote:      return .footnote
    case .caption:       return .caption
    case .caption2:      return .caption2
    @unknown default:    return .body
    }
}
#endif

extension View {
    func scaledFont(_ style: Font.TextStyle) -> some View {
        modifier(ScaledFontModifier(style: style))
    }
}

// MARK: - Server URL scheme validation
//
// Security-Nachbesserung: `serverURL` ist ein vom Nutzer frei editierbares
// Feld (Einstellungen), dessen Wert Session-Cookie und (beim biometrischen
// Unlock) das Klartext-Passwort trägt. Ungeprüft akzeptiertes `http://`
// würde beides im Klartext übertragen. https:// ist immer erlaubt; http://
// wird nur für lokale Entwicklung gegen localhost/127.0.0.1/::1 durchgelassen
// (analog zur SSRF-Loopback-Ausnahme im Backend, lib/safe-fetch.js).
func isAllowedServerURLScheme(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    if scheme == "https" { return true }
    if scheme == "http" {
        let host = url.host?.lowercased() ?? ""
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }
    return false
}

/// Normiert eine vom Nutzer im Einstellungen-Formular eingegebene Server-URL
/// (Whitespace + abschließende Schrägstriche entfernen) - reine Funktion,
/// von `SettingsURLView` UND von Tests genutzt (Muster: `TodoOverviewLogic`
/// in TodosView.swift - View-Logik wird als testbare freie Funktion/Enum
/// ausgelagert statt in einer privaten computed property der View zu
/// verstecken).
func trimmedServerURLInput(_ raw: String) -> String {
    raw.trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}

/// Ob eine vom Nutzer eingegebene (bereits getrimmte) Server-URL gespeichert
/// werden darf: muss ein gültiges URL + ein erlaubtes Scheme haben (siehe
/// `isAllowedServerURLScheme`). Security-Nachbesserung: wird beim SPEICHERN
/// in `SettingsURLView` angewendet, nicht erst beim nächsten Netzwerk-Request
/// (`AppState.url(_:)` u.a. prüfen ohnehin nochmal, das hier ist zusätzliches,
/// frühzeitiges Nutzer-Feedback).
func isValidServerURLInput(_ trimmed: String) -> Bool {
    guard !trimmed.isEmpty, let u = URL(string: trimmed) else { return false }
    return isAllowedServerURLScheme(u)
}

// MARK: - Color from hex

extension Color {
    init(hex: String) {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let n = UInt64(h, radix: 16) ?? 0
        let r, g, b: Double
        if h.count == 6 {
            r = Double((n >> 16) & 0xFF) / 255
            g = Double((n >>  8) & 0xFF) / 255
            b = Double( n        & 0xFF) / 255
        } else { r = 0; g = 0; b = 0 }
        self.init(red: r, green: g, blue: b)
    }
}

// MARK: - HTML strip (plain text, e.g. for search)

func stripHTML(_ s: String) -> String {
    guard s.contains("<") else { return s }
    var result = ""
    var inTag = false
    for ch in s {
        if      ch == "<" { inTag = true }
        else if ch == ">" { inTag = false }
        else if !inTag    { result.append(ch) }
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - HTML → AttributedString (preserves bold, italic, color, links)
//
// Security-Nachbesserung: früher nutzte macOS `NSAttributedString(data:
// options:[.documentType:.html])`, was intern WebKits HTML-Importer
// verwendet - dieser lädt referenzierte Ressourcen (`<img src="https://…">`,
// `<link rel="stylesheet">`, CSS `@import`) OHNE CSP/Sandboxing nach
// (Tracking-Pixel-/SSRF-artiger Vektor bei serverseitig/fremd erzeugtem
// HTML, z. B. Todo-/Topic-/Contact-Beschreibungen). Der eigenständige,
// netzwerklose State-Machine-Parser (ursprünglich nur für iOS, da
// `NSAttributedString(HTML)` dort undokumentierte ObjC-Exceptions werfen
// konnte, die `try?` nicht abfängt) wird daher jetzt auf beiden Plattformen
// verwendet - er unterstützt ausschließlich ein festes Set harmloser Tags
// (b/strong/i/em/u/br/p/div/li/span mit color/a mit href) und kann prinzip-
// bedingt nie einen Netzwerk-Request auslösen.

func htmlAttributedString(_ html: String) -> AttributedString {
    guard html.contains("<") else { return AttributedString(html) }
    return _parseHTMLSafe(html)
}

// Simple state-machine HTML parser for the tags the web editor produces.
// Cross-platform (SwiftUI `Color`), keine Abhängigkeit von UIKit/AppKit.
private func _parseHTMLSafe(_ html: String) -> AttributedString {
    var result = AttributedString()
    var boldDepth = 0
    var italicDepth = 0
    var underlineDepth = 0
    var colorStack: [Color] = []
    var linkStack: [URL] = []
    var buf = ""

    func flush() {
        guard !buf.isEmpty else { return }
        let text = buf
            .replacingOccurrences(of: "&amp;",  with: "&")
            .replacingOccurrences(of: "&lt;",   with: "<")
            .replacingOccurrences(of: "&gt;",   with: ">")
            .replacingOccurrences(of: "&nbsp;", with: "\u{00A0}")
            .replacingOccurrences(of: "&#39;",  with: "'")
            .replacingOccurrences(of: "&quot;", with: "\"")
        var chunk = AttributedString(text)
        var container = AttributeContainer()
        // Font (bold / italic combinations)
        let b = boldDepth > 0, it = italicDepth > 0
        if b || it {
            var base = Font.system(size: 13)
            if b  { base = base.bold() }
            if it { base = base.italic() }
            container.font = base
        }
        // Underline
        if underlineDepth > 0 { container.underlineStyle = .single }
        // Color
        if let c = colorStack.last { container.foregroundColor = c }
        // Link
        if let u = linkStack.last { container.link = u }
        chunk.mergeAttributes(container)
        result += chunk
        buf = ""
    }

    var i = html.startIndex
    while i < html.endIndex {
        if html[i] != "<" { buf.append(html[i]); i = html.index(after: i); continue }
        flush()
        guard let close = html[i...].firstIndex(of: ">") else {
            buf.append(html[i]); i = html.index(after: i); continue
        }
        let raw  = String(html[html.index(after: i)..<close])
        let tag  = raw.lowercased().trimmingCharacters(in: .whitespaces)
        i = html.index(after: close)

        switch tag {
        case "b", "strong":           boldDepth += 1
        case "/b", "/strong":         boldDepth = max(0, boldDepth - 1)
        case "i", "em":               italicDepth += 1
        case "/i", "/em":             italicDepth = max(0, italicDepth - 1)
        case "u":                     underlineDepth += 1
        case "/u":                    underlineDepth = max(0, underlineDepth - 1)
        case "br", "br/", "br /":     buf.append("\n")
        case "/p", "/div", "/li":     buf.append("\n")
        case "/span":                 if !colorStack.isEmpty { colorStack.removeLast() }
        case "/a":                    if !linkStack.isEmpty  { linkStack.removeLast() }
        default:
            if tag.hasPrefix("span") {
                // style="color: #rrggbb" or color: rgb(r,g,b)
                let color = _extractCSS(raw, key: "color").flatMap { Color(cssHex: $0) }
                colorStack.append(color ?? .primary)
            } else if tag.hasPrefix("a ") {
                // href="..." or href='...'
                if let url = _extractHref(raw) { linkStack.append(url) }
            }
        }
    }
    flush()
    return result
}

private func _extractCSS(_ tag: String, key: String) -> String? {
    guard let styleRange = tag.range(of: "style\\s*=\\s*[\"']([^\"']*)[\"']",
                                     options: .regularExpression) else { return nil }
    let style = String(tag[styleRange])
    for part in style.components(separatedBy: ";") {
        let kv = part.components(separatedBy: ":").map { $0.trimmingCharacters(in: .whitespaces) }
        if kv.count >= 2 && kv[0].hasSuffix(key) {
            return kv[1...].joined(separator: ":").trimmingCharacters(in: .init(charactersIn: " ;\"'"))
        }
    }
    return nil
}

private func _extractHref(_ tag: String) -> URL? {
    guard let r = tag.range(of: #"href\s*=\s*["']([^"']+)["']"#, options: .regularExpression) else { return nil }
    let s = String(tag[r])
    guard let q1 = s.firstIndex(where: { $0 == "\"" || $0 == "'" }) else { return nil }
    let rest = s[s.index(after: q1)...]
    guard let q2 = rest.firstIndex(where: { $0 == "\"" || $0 == "'" }) else { return nil }
    return URL(string: String(rest[rest.startIndex..<q2]))
}

extension Color {
    init?(cssHex: String) {
        let s = cssHex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") {
            let hex = String(s.dropFirst())
            guard let v = UInt64(hex, radix: 16) else { return nil }
            switch hex.count {
            case 6: self.init(red:   Double((v >> 16) & 0xFF) / 255,
                              green: Double((v >>  8) & 0xFF) / 255,
                              blue:  Double( v        & 0xFF) / 255)
            case 3: let r = (v >> 8) & 0xF; let g = (v >> 4) & 0xF; let b = v & 0xF
                    self.init(red:   Double(r * 17) / 255,
                              green: Double(g * 17) / 255,
                              blue:  Double(b * 17) / 255)
            default: return nil
            }
        } else if s.hasPrefix("rgb(") {
            let nums = s.dropFirst(4).dropLast()
                .split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard nums.count == 3 else { return nil }
            self.init(red: nums[0] / 255, green: nums[1] / 255, blue: nums[2] / 255)
        } else { return nil }
    }
}

// MARK: - Cross-platform modifiers

extension View {
    /// `.navigationBarTitleDisplayMode(.inline)` on iOS; no-op on macOS.
    func inlineTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// `.keyboardType(.numbersAndPunctuation)` on iOS; no-op on macOS.
    func numberKeyboard() -> some View {
        #if os(iOS)
        self.keyboardType(.numbersAndPunctuation)
        #else
        self
        #endif
    }

    /// `.keyboardType(.URL)` on iOS; no-op on macOS.
    func urlKeyboard() -> some View {
        #if os(iOS)
        self.keyboardType(.URL)
        #else
        self
        #endif
    }

    /// `.textInputAutocapitalization(.never)` on iOS; no-op on macOS.
    func noAutocapitalize() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    /// Zeigt einen generischen "Fehler"-Alert, solange `error.wrappedValue`
    /// nicht `nil` ist, und setzt ihn beim Schließen automatisch zurück.
    ///
    /// Arbeit zur Lesbarkeit/Wartbarkeit: ersetzt denselben, zuvor 12x fast
    /// wortgleich kopierten `.alert("Fehler", isPresented: Binding(get: ...,
    /// set: ...)) { Button("OK", role: .cancel) {} } message: { Text(...) }`-
    /// Block in ContentView/GraphView/TodosView/ThemesView/
    /// MeetingDetailView/ProgressTimelineView/MeetingArchiveView/
    /// SidebarView/KnowledgeView/KnowledgeImagePicker/ContactsView/
    /// AdminView. Nimmt bewusst eine `Binding<String?>` (nicht direkt das
    /// `@State`), damit Aufrufer mit einem anderen Variablennamen (z. B.
    /// `deleteErrorText`) oder einer abgeleiteten Fehlermeldung weiterhin
    /// `$someVar` übergeben können, ohne diese Property umzubenennen.
    func errorAlert(_ error: Binding<String?>) -> some View {
        alert("Fehler", isPresented: Binding(
            get: { error.wrappedValue != nil },
            set: { if !$0 { error.wrappedValue = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error.wrappedValue ?? "")
        }
    }
}
