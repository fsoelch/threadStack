import SwiftUI

/// Design System tokens.
/// Named `DS` to avoid collision with the `Theme` data model in Models.swift.
enum DS {
    static let accent       = Color(hex: "#1D6FE8")
    static let accentDark   = Color(hex: "#1560CC")
    static let accentLight  = Color(hex: "#EBF2FD")
    static let green        = Color(hex: "#22C55E")
    // Neutraler Status-Ring fuer offene (nicht erledigte) Vorhaben, analog
    // zum Web-Pendant `.topic-status-icon.open`/`.topic-card.open::before`
    // (`#BABCD4`, public/index.html) — bewusst kein Gruen/Blau, das im Web
    // ausschliesslich "erledigt" bzw. Marken/Aktionen kennzeichnet.
    static let neutralRing  = Color(hex: "#BABCD4")
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

    // Arbeit zur Lesbarkeit/Wartbarkeit: Radius-Skala fuer die vielen bisher
    // ad-hoc verstreuten `cornerRadius:`-Literale (6/8/10/12), aufsteigend
    // neben dem bereits bestehenden `cardRadius` (16, groesste/aeusserste
    // Stufe, unverändert). Reine Benennung bereits vorhandener Werte, KEINE
    // visuelle Aenderung.
    static let radiusXS: CGFloat = 6
    static let radiusS:  CGFloat = 8
    static let radiusM:  CGFloat = 10
    static let radiusL:  CGFloat = 12

    // Weitere, bisher als Farb-Literale duplizierte Werte. `brandIndigo` ist
    // bewusst NICHT `accent` (andere Farbe, `#1D6FE8`) - beide Marken-/
    // Akzentfarben existieren nebeneinander in der bestehenden UI.
    static let brandIndigo  = Color(hex: "#6366f1")
    static let dangerBg     = Color(hex: "#fee2e2")
    static let dangerFg     = Color(hex: "#b91c1c")
    static let warningBg    = Color(hex: "#fef3c7")
    static let warningFg    = Color(hex: "#92400e")
    static let borderMuted  = Color(hex: "#e2e8f0")
}
