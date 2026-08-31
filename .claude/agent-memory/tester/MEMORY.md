# Tester Memory — personly / ThreadStack

## Wiederkehrende Randfaelle, die bei aehnlichen Themes/Todo/Knowledge-Aenderungen zu pruefen sind

- Bei jeder Aenderung an Topic<->Ref-Zuordnungen (theme_links,
  knowledge_topic_links) immer explizit testen: (a) fremde/geloeschte
  Theme-IDs werden verworfen statt Fehler zu werfen (droppedCount), (b)
  Ownership-Pruefung auf der Ziel-Ressource selbst (todo/knowledge), nicht
  nur auf den Theme-IDs, (c) atomarer Ersatz (kein Anhaeufen alter Links
  bei wiederholtem Speichern).
- AI-Features (theme_tagging, digest, cross_meeting, drift) sind per
  Default AUSGESCHALTET und benoetigen zusaetzlich einen konfigurierten
  AI-Provider - "funktioniert nicht automatisch" bei diesen Features ist
  oft kein Bug, sondern fehlende Konfiguration/fehlendes Enablement. Vor
  einer Bug-Einstufung immer pruefen, ob es sich um ein bewusst
  deaktiviertes Feature handelt (siehe ai/settings.js DEFAULT_FEATURES).
- Bei AppState-Netzwerkmethoden, die `try? ... ?? []` nutzen: das
  verschleiert 401/Netzwerkfehler als "leeres Ergebnis" - bei
  Topic-Detail-Screens (Wissen/Todos) besonders relevant, da ein Nutzer
  das nicht von einem tatsaechlich leeren Topic unterscheiden kann.
