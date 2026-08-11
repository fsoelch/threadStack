import SwiftUI

/// Design System tokens.
/// Named `DS` to avoid collision with the `Theme` data model in Models.swift.
enum DS {
    static let accent       = Color(hex: "#1D6FE8")
    static let accentDark   = Color(hex: "#1560CC")
    static let accentLight  = Color(hex: "#EBF2FD")
    static let green        = Color(hex: "#22C55E")
    static let orange       = Color(hex: "#F97316")
    static let purple       = Color(hex: "#9B5FE8")
    static let pink         = Color(hex: "#E8479B")
    static let cyan         = Color(hex: "#06B6D4")
    // Adaptive Hintergruende (hell/dunkel), statt frueher hart auf hellgrau
    // kodiert (#F2F2F7) — das liess den Hintergrund im Dark Mode faelschlich
    // hell, waehrend Text ueber .primary/.secondary korrekt auf hell umschaltete
    // und dadurch praktisch unsichtbar wurde.
    #if os(iOS)
    static let groupedBg    = Color(uiColor: .systemGroupedBackground)
    static let cardBg       = Color(uiColor: .secondarySystemGroupedBackground)
    #else
    static let groupedBg    = Color(nsColor: .windowBackgroundColor)
    static let cardBg       = Color(nsColor: .controlBackgroundColor)
    #endif
    static let cardRadius: CGFloat = 16
    static let cardShadow   = Color.black.opacity(0.05)
}
