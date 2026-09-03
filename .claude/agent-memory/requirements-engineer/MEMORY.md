# Requirements-Engineer Memory — personly / ThreadStack

## Verwirrende Domaenen-Begriffe (immer zuerst am Code pruefen, nicht raten)

- Es gibt ZWEI völlig unterschiedliche DB-Konzepte, deren UI-Label GENAU
  VERTAUSCHT zum naheliegenden Namen ist:
  - DB-Tabelle `topics` (Meeting-Tagesordnungspunkte) → UI-Label **"Thema"**
    (Plural "Themen"). Hat wie ein Todo einen eigenen Zwischenstand/
    Fortschrittsverlauf und kann auf den Stack gelegt werden.
  - DB-Tabelle `themes` (hierarchische Tag-/Ordner-Struktur zum Verschlagworten
    von Todos/Themen/Kontakten) → UI-Label **"Topic"**. Rein organisatorisch,
    hat KEINEN Zwischenstand und ist NICHT stack-faehig.
  - Wenn ein Mensch von "Themen" spricht, meint er (Plural von "Thema") fast
    immer die Meeting-Tagesordnungspunkte (`topics`-Tabelle), NICHT die
    "Topic"-Hierarchie (`themes`-Tabelle) — trotz der englischen Namensnähe
    von "Topic" zu "Thema". Im Zweifel am Code/an der UI-Beschriftung
    verifizieren, nicht am englischen Wortklang.
- "ToDos" und "Themen" (`topics`) sind die beiden gleichwertigen "Vorhaben"-
  Typen im Stack-/Fortschritts-Feature. Feature-Paritaet zwischen beiden ist
  ein wiederkehrendes Thema von Nutzeranfragen — bei "X existiert bei Todos,
  aber nicht bei Themen (oder umgekehrt)" immer BEIDE Implementierungen
  (renderPersonalTodoCard vs. renderTopicCard/renderMeetingTopicTodo,
  openTodoModal vs. openTopicModal) direkt vergleichen, bevor man eine
  Annahme trifft — Divergenz zwischen ihnen ist laut CLAUDE.md ein Bug.
- "Der Stack" ist ein voll ausgebautes Web-Feature (Tabelle `stack_frames`,
  `/api/stack/*`), nicht nur der Name der iOS-Begleit-App "ThreadStack".
- "Zwischenstand" = ein Fortschritts-Eintrag (`lib/progress/`, Tabelle
  `progress_entries`) an einem Todo oder Thema, ueber `TSProgress.
  mountInlineComposer` (public/progress.js) erfasst.
