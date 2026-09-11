---
name: workflow-lastenheft
description: Wie ein bereits angelegter Lastenheft-Eintrag ersetzt statt dupliziert wird, wenn der Nutzer offene Fragen nachtraeglich entscheidet
metadata:
  type: feedback
---

Wenn der Nutzer offene Fragen aus einer frueheren Analyse nachtraeglich
entscheidet, wird der bereits angelegte Eintrag in
`Lastenheft_ThreadStack_v2.0.docx` ERSETZT, nicht ein zweiter Eintrag mit
gleichem Datum daneben angelegt.

**Why:** Zwei Eintraege zum selben Feature am selben Tag widersprechen sich
(alter Stand enthaelt noch die offenen Fragen) und machen das Lastenheft als
Referenz unbrauchbar. Der Nutzer hat das beim Ansprechpartner-Feature
explizit so eingefordert.

**How to apply:** Eigenen Vor-Eintrag ueber seinen Titel-Text finden, den
umgebenden `<w:p>`-Block per `rfind('<w:p>', 0, idx)` als Start und den
folgenden `<w:sectPr>` (bzw. den naechsten fremden Eintrag) als Ende
bestimmen, und nur diesen Bereich austauschen. Vor dem Schreiben absichern,
dass der Ersetzungsbereich keine fremden Inhalte umfasst (kein `Heading1`,
keine fremden Eintragstitel, plausible Absatzzahl) und der Marker genau
einmal vorkommt - sonst abbrechen und das Original unveraendert lassen.
Danach XML-Wohlgeformtheit pruefen, neu zippen, `[Content_Types].xml` +
`word/document.xml` im ZIP verifizieren, erst dann ueberschreiben.

Das Ersetzen des EIGENEN Eintrags ist die einzige Ausnahme von "nur
anhaengen" - fremde Abschnitte bleiben unangetastet.
