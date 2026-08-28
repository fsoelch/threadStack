'use strict';
// Reine Text-Hilfsfunktionen, aus ai/index.js extrahiert (Arbeit zur
// Lesbarkeit/Wartbarkeit) - Verhalten unveraendert.

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Neutralisiert Fragmente, die wie unsere Nonce-Marker aussehen, in Werten,
// die aus nicht vertrauenswürdigen/externen Nutzerdaten stammen (Titel,
// Fortschrittseinträge, Beschreibungen, Seiteninhalt). Modulweiter Helper,
// ursprünglich in summarizeLink eingeführt und für S2
// (summarizeProgress/summarizeDescription) weiterverwendet, um dieselbe
// Härtung ohne Duplikation wiederzuverwenden (Security-Review-Muster).
function neutralizeMarkers(s) {
  return String(s || '').replace(/<<<INHALT-?[0-9a-f]*|INHALT-?[0-9a-f]*>>>/gi, '[…]');
}

module.exports = { stripHtml, neutralizeMarkers };
