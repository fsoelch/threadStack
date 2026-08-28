# ThreadStack iOS/macOS App

SwiftUI multiplatform app (iOS 17+ / macOS 14+) that connects to the ThreadStack server.

## Xcode Project Setup

Since there is no `.xcodeproj` yet, follow these steps to create one:

### 1. Create a new Xcode project

1. Open Xcode → **File → New → Project**
2. Choose **Multiplatform → App**
3. Set:
   - **Product Name:** `ThreadStack`
   - **Bundle Identifier:** e.g. `com.yourname.threadstack`
   - **Interface:** SwiftUI
   - **Language:** Swift
4. Choose the `ThreadStackApp` folder as the project location
5. When Xcode creates the project, it adds a default `ContentView.swift` — **delete it** (move to trash)

### 2. Add all Swift files

Drag all `.swift` files from this folder into the Xcode project navigator. Make sure **"Add to targets"** is checked for both iOS and macOS targets.

Files to add:
- `ThreadStackApp.swift`
- `Models.swift`
- `AppState.swift`
- `Extensions.swift`
- `ContentView.swift`
- `LoginView.swift`
- `SidebarView.swift`
- `MeetingDetailView.swift`
- `TopicFormView.swift`
- `TodosView.swift`
- `TodoFormView.swift`
- `ThemesView.swift`
- `HelperViews.swift`
- `SettingsView.swift`
- `AdminView.swift`

### 3. Configure App Transport Security (for HTTP servers)

If your server uses **HTTPS** (recommended), skip this step.

**Hinweis (Security):** Die App akzeptiert `http://` als Server-URL ohnehin
nur für lokale Entwicklungs-Hosts (`localhost`/`127.0.0.1`/`::1`, siehe
`isAllowedServerURLScheme` in `Extensions.swift`) — jeder andere `http://`-Host
wird bereits auf Code-Ebene abgelehnt, unabhängig von der ATS-Konfiguration.
`NSAllowsArbitraryLoads` ist daher **nicht nötig und nicht empfohlen** für den
produktiven Einsatz: es würde ATS-Schutz app-weit (auch für andere Netzwerk-
aufrufe) deaktivieren, ohne die App-eigene Prüfung zu umgehen. Nur relevant,
falls gegen einen lokalen `http://`-Server auf einem **echten Gerät** (nicht
Simulator) getestet wird und ATS die Loopback-Ausnahme nicht greift:

For HTTP-only local dev on a real device: in Xcode, select your target → **Info** tab → add key:
```
App Transport Security Settings → Allow Arbitrary Loads → YES
```

Or add to `Info.plist`:
```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
</dict>
```

### 4. Run

- Select the **iPhone Simulator** or **My Mac (Mac Catalyst)** scheme
- Press **⌘R** to build and run
- On first launch, tap **Einstellungen** and enter your server URL (e.g. `https://myserver.example.com`)
- Log in with your ThreadStack credentials

## Notes

- No Apple Developer account is needed for Simulator or Mac (My Mac) builds
- Session cookies are stored in `HTTPCookieStorage.shared` and persist across launches
- All API calls go to `<serverURL>/api/...`
