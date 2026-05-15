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

// MARK: - HTML strip

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
}
