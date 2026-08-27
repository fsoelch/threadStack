'use strict';
// Sanitizing-Wrapper für den Fortschrittsverlauf (Arbeitspaket S1).
//
// Baut bewusst KEINE zweite Allowlist auf, sondern wraps ausschließlich die
// bereits vorhandene, geteilte Lösung aus lib/sanitize.js
// (sanitizeKnowledgeHtml / htmlToText). Zwischenstände sind reiner
// "Rich-Text-Notiz"-Inhalt ohne eingebettete Medien - Bilder/Video/Audio
// werden daher VOR dem Allowlist-Sanitizing entfernt (Produktentscheidung,
// nicht Teil der Knowledge-Allowlist, die img bewusst erlaubt).
//
// Alle Funktionen hier sind reine Transformationen und werfen NIE - jegliche
// Längenprüfung/Ablehnung von zu langen Eingaben passiert bewusst NICHT hier,
// sondern in lib/progress/routes.js (siehe MAX_*-Konstanten unten, die dort
// importiert werden).
const { sanitizeKnowledgeHtml, htmlToText } = require('../sanitize');

// Plaintext-Obergrenze NACH Sanitizing für einen Zwischenstand (Story 2).
const MAX_PROGRESS_TEXT = 5000;
// Harte Roh-HTML-Obergrenze VOR jeglichem Sanitizing (reiner Payload-Schutz
// gegen übergroße Requests, unabhängig vom späteren Plaintext-Ergebnis).
const MAX_PROGRESS_HTML = 50000;
// Nächster Schritt (Klartext-Feld). MUSS identisch zur bestehenden
// Stack-Notiz-Grenze in server.js bleiben (`const MAX_NOTE = 1000;`,
// siehe Zeile ~1949 dort) - S2 gleicht das gegen server.js ab, siehe
// test/rate_limit... nein: test/progress_sanitize.test.js, das den
// Wert 1000 explizit gegen den Wortlaut in server.js verifiziert.
const MAX_NEXT_STEP = 1000;

// Attribut-bewusstes Tag-Matching: überspringt `>` innerhalb von quoted
// Attributwerten (z.B. `<img alt=">">`), damit ein naives `[^>]*` nicht zu
// früh abbricht.
const ATTR = `(?:"[^"]*"|'[^']*'|[^'">])*`;
const VOID_TAGS = ['img', 'source'];
const CONTAINER_TAGS = ['video', 'audio'];

/**
 * Entfernt <img>/<video>/<audio>/<source> vollständig (inkl. Inhalt bei
 * video/audio) aus rohem HTML, BEVOR die eigentliche Allowlist
 * (sanitizeKnowledgeHtml) greift. Rein defensiv per Regex - die eigentliche
 * Sicherheitsgrenze bleibt die nachgelagerte Allowlist.
 * @param {string} html
 * @returns {string}
 */
function stripDisallowedMediaTags(html) {
  let out = String(html);
  for (const tag of CONTAINER_TAGS) {
    // Ganzes Element inkl. Inhalt (nicht-gierig, über Zeilenumbrüche hinweg).
    out = out.replace(new RegExp(`<${tag}\\b${ATTR}>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    // Defensiv: verwaiste/selbstschließende bzw. unclosed Vorkommen.
    out = out.replace(new RegExp(`<${tag}\\b${ATTR}\\/?>`, 'gi'), '');
    out = out.replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), '');
  }
  for (const tag of VOID_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b${ATTR}\\/?>`, 'gi'), '');
  }
  return out;
}

/**
 * Sanitizing für den Rich-Text-Inhalt eines Zwischenstands: entfernt zuerst
 * Medien-Tags, wendet danach die geteilte Knowledge-Allowlist an.
 * @param {*} html
 * @returns {string}
 */
function sanitizeProgressHtml(html) {
  if (html == null) return '';
  const withoutMedia = stripDisallowedMediaTags(String(html));
  // Die eigentliche Sicherheitsgrenze ist `allowImages:false` in der
  // Allowlist selbst (nicht der Regex-Vorstrip oben) - so überlebt auch ein
  // durch Tag-Verschachtelung neu zusammengesetztes <img> nicht (Security
  // Review, Mittel: F1).
  return sanitizeKnowledgeHtml(withoutMedia, { allowImages: false });
}

/**
 * Reiner Klartext-Auszug eines (bereits sanitizten) HTML-Fragments, mit
 * normalisiertem Whitespace. Ausschließlich für Längenprüfung/Vorschau -
 * niemals als direkt renderbares HTML verwenden.
 * @param {*} html
 * @returns {string}
 */
function progressPlainText(html) {
  const text = htmlToText(html);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Für reine Klartext-Felder (Zielbild, Nächster Schritt): entfernt jegliches
 * Markup (auch versehentlich eingefügtes), normalisiert Whitespace.
 * @param {*} value
 * @returns {string}
 */
function sanitizePlainField(value) {
  const text = htmlToText(value);
  // htmlToText dekodiert Entities fuer Lesbarkeit (z.B. "AT&amp;T" -> "AT&T").
  // Bei mehrfach kodierter Eingabe (z.B. "&amp;lt;script&amp;gt;") kann das
  // dabei wieder wie Markup aussehende Zeichenfolgen erzeugen. Da dieses
  // Feld vertraglich reiner Klartext ist (Zielbild/Naechster Schritt),
  // werden verbleibende spitze Klammern entfernt statt sie zu interpretieren
  // (Security Review, Mittel: F2).
  return text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Kürzt einen Klartext wortweise auf maximal `n` Zeichen, mit '…' am Ende
 * falls gekürzt wurde. Bricht nicht mitten in einem Wort ab (sofern ein
 * Wortumbruch innerhalb der ersten `n` Zeichen existiert).
 * @param {*} text
 * @param {number} [n=280]
 * @returns {string}
 */
function truncateExcerpt(text, n = 280) {
  const str = text == null ? '' : String(text);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (str.length <= limit) return str;
  if (limit === 0) return str.length ? '…' : '';
  let cut = str.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return cut.trimEnd() + '…';
}

module.exports = {
  sanitizeProgressHtml,
  progressPlainText,
  sanitizePlainField,
  truncateExcerpt,
  MAX_PROGRESS_TEXT,
  MAX_PROGRESS_HTML,
  MAX_NEXT_STEP,
};
