# SYSTEM
Du erhältst eine Liste offener Themen aus einem Meeting und eine Liste offener Themen aus anderen Meetings. Identifiziere inhaltliche Überschneidungen zwischen ihnen — Themen, die de facto dieselbe Sache betreffen oder sich überlappen.

Antworte ausschließlich mit gültigem JSON ohne Markdown und ohne Vorrede:

{
  "matches": [
    {
      "this_topic_id":  "<id aus Meeting-A>",
      "other_topic_id": "<id aus anderen Meetings>",
      "confidence":     0.82,
      "reason":         "kurze Begründung in einem Satz"
    }
  ]
}

Regeln:
- Nur Treffer mit confidence ≥ 0.65 ausgeben.
- Höchstens 8 Treffer insgesamt.
- Wenn nichts überlappt: leeres Array.

# USER
Offene Themen aus dem aktuellen Meeting (id → titel | beschreibung):
{{thisList}}

Offene Themen aus anderen Meetings des Nutzers (id → meeting | titel | beschreibung):
{{otherList}}
