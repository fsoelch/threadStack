import Foundation
import Security
import LocalAuthentication

// MARK: - Errors

enum KeychainError: LocalizedError {
    case unhandled(OSStatus)
    case itemNotFound
    case userCancelled
    case unavailable

    var errorDescription: String? {
        switch self {
        case .unhandled(let s): return "Keychain-Fehler (\(s))"
        case .itemNotFound:     return "Keine gespeicherten Anmeldedaten."
        case .userCancelled:    return "Authentifizierung abgebrochen."
        case .unavailable:      return "Biometrie auf diesem Gerät nicht verfügbar."
        }
    }
}

struct StoredCredentials {
    let username: String
    let password: String
}

// MARK: - Keychain wrapper

enum Keychain {
    private static let service = "com.threadstack.app.credentials"
    private static let account = "default"

    /// Prüft ob Face ID / Touch ID / Optic ID auf dem Gerät verfügbar ist.
    static var biometryAvailable: Bool {
        let ctx = LAContext()
        var err: NSError?
        return ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
    }

    /// "Face ID" / "Touch ID" / "Optic ID" / "Biometrie".
    static var biometryTypeDescription: String {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
            return "Geräte-Authentifizierung"
        }
        switch ctx.biometryType {
        case .faceID:  return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default:       return "Biometrie"
        }
    }

    /// SF-Symbol passend zur Biometrie-Art (gemeinsam fuer Lock-Screen und Login).
    static var biometryIconName: String {
        switch biometryTypeDescription {
        case "Face ID":  return "faceid"
        case "Touch ID": return "touchid"
        case "Optic ID": return "opticid"
        default:         return "lock.shield"
        }
    }

    /// Speichert Username + Passwort verschlüsselt, geschützt durch Biometrie (Fallback: Geräte-Passcode).
    /// Speicherung ausschließlich auf diesem Gerät (kein iCloud-Sync).
    static func save(username: String, password: String) throws {
        let data = try JSONEncoder().encode(["u": username, "p": password])

        // Existierenden Eintrag entfernen
        let baseQuery: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        // Access Control: Biometrie oder Passcode-Fallback ("userPresence"), nur dieses Gerät.
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .userPresence,
            &accessError
        ) else {
            throw KeychainError.unavailable
        }

        let attrs: [String: Any] = [
            kSecClass as String:             kSecClassGenericPassword,
            kSecAttrService as String:       service,
            kSecAttrAccount as String:       account,
            kSecValueData as String:         data,
            kSecAttrAccessControl as String: access,
        ]
        let status = SecItemAdd(attrs as CFDictionary, nil)
        if status != errSecSuccess { throw KeychainError.unhandled(status) }
        storedHint = true
    }

    /// Liefert die Credentials nach erfolgreichem Biometrie-Prompt.
    static func load(prompt: String = "Anmelden") throws -> StoredCredentials {
        let ctx = LAContext()
        ctx.localizedReason = prompt

        let query: [String: Any] = [
            kSecClass as String:                    kSecClassGenericPassword,
            kSecAttrService as String:              service,
            kSecAttrAccount as String:              account,
            kSecReturnData as String:               true,
            kSecMatchLimit as String:               kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: ctx,
        ]
        var item: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        switch status {
        case errSecSuccess:        break
        case errSecItemNotFound:   throw KeychainError.itemNotFound
        case errSecUserCanceled:   throw KeychainError.userCancelled
        case errSecAuthFailed:     throw KeychainError.userCancelled
        default:                   throw KeychainError.unhandled(status)
        }

        guard let data = item as? Data,
              let dict = try? JSONDecoder().decode([String: String].self, from: data),
              let u = dict["u"], let p = dict["p"]
        else { throw KeychainError.itemNotFound }

        return StoredCredentials(username: u, password: p)
    }

    /// Entfernt gespeicherte Credentials.
    static func clear() {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        storedHint = false
    }

    /// Prüft ob Credentials gespeichert sind — OHNE Biometrie-Prompt auszulösen.
    ///
    /// Frueher per `kSecUseAuthenticationUISkip`: laut Apple werden Biometrie-geschuetzte Eintraege damit
    /// UEBERSPRUNGEN (`errSecItemNotFound`) - die App hielt die Anmeldedaten dann fuer "nicht vorhanden"
    /// und zeigte nach Ablauf der Server-Sitzung das Login-Formular statt Face ID. Jetzt: LAContext mit
    /// `interactionNotAllowed` (offizieller Ersatz) PLUS ein nicht-geheimer Merker in den UserDefaults
    /// als Rueckfallebene. Stimmt der Merker nicht mehr (Eintrag fehlt doch), endet das Entsperren mit
    /// `itemNotFound`, und der Lock-Screen faellt sauber auf das Login-Formular zurueck.
    static var hasStoredCredentials: Bool {
        keychainItemExists || storedHint
    }

    private static var keychainItemExists: Bool {
        let ctx = LAContext()
        ctx.interactionNotAllowed = true
        let query: [String: Any] = [
            kSecClass as String:                    kSecClassGenericPassword,
            kSecAttrService as String:              service,
            kSecAttrAccount as String:              account,
            kSecMatchLimit as String:               kSecMatchLimitOne,
            kSecReturnAttributes as String:         true,
            kSecUseAuthenticationContext as String: ctx,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        // errSecInteractionNotAllowed = Item existiert, würde aber Auth verlangen → es ist also da.
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    /// Nicht-geheimer Merker "es wurden Anmeldedaten mit Biometrie gespeichert" (enthaelt keine Zugangsdaten).
    private static let storedHintKey = "com.threadstack.app.credentialsStoredHint"
    private static var storedHint: Bool {
        get { UserDefaults.standard.bool(forKey: storedHintKey) }
        set { UserDefaults.standard.set(newValue, forKey: storedHintKey) }
    }
}
