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
    static let groupedBg    = Color(hex: "#F2F2F7")
    static let cardRadius: CGFloat = 16
    static let cardShadow   = Color.black.opacity(0.05)
}
