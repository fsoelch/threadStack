'use strict';

/**
 * Farbnormalisierung, Kontrastpruefung und Style-Attribut-Sanitizing.
 *
 * Wird sowohl vom HTML-Sanitizer (server-/editorseitig) als auch vom
 * Word-Export (export/html/*.js, export/docxTheme.js) genutzt.
 *
 * WICHTIG (Sicherheit): normalizeColor/sanitizeStyleAttribute sind striktes
 * Allowlisting. Es werden NIE Farbnamen, Funktionen (hsl/var/calc/url) oder
 * sonstige CSS-Deklarationen ausser `color` akzeptiert. Keine der Funktionen
 * wirft eine Exception - ungueltige/fehlerhafte Eingaben fuehren immer zu
 * null/'' als Rueckgabewert, damit ein Speicher-/Exportvorgang niemals durch
 * eine Farbeingabe abgebrochen werden kann.
 */

/** Kanonische Editor-Palette; alle Werte erfuellen >=4,5:1 gegen Weiss. */
const PALETTE = Object.freeze({
  standard: '#1a1918',
  rot: '#dc2626',
  orange: '#c2410c',
  gelb: '#a16207',
  gruen: '#15803d',
  blau: '#2563eb',
  violett: '#7c3aed',
  grau: '#6b7280',
});

const HEX3_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6_RE = /^#([0-9a-f]{6})$/i;
// Kein verschachtelter Quantifizierer, feste kleine Obergrenzen -> kein ReDoS.
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/**
 * Relative Luminanz nach WCAG 2.1 fuer ein sRGB-Kanal-Byte (0..255).
 * @param {number} channel
 * @returns {number}
 */
function srgbChannelToLinear(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Relative Luminanz eines {r,g,b}-Tripels (0..255 je Kanal).
 * @param {{r:number,g:number,b:number}} rgb
 * @returns {number}
 */
function relativeLuminance(rgb) {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Parst einen bereits kanonischen '#rrggbb'-String in {r,g,b}.
 * Gibt null zurueck, wenn das Format nicht passt (kein throw).
 * @param {string} hex
 * @returns {{r:number,g:number,b:number}|null}
 */
function parseCanonicalHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = HEX6_RE.exec(hex);
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

/**
 * WCAG-2.1-Kontrastverhaeltnis einer Hex-Farbe gegen #ffffff.
 * @param {string} hex '#rrggbb'
 * @returns {number} 1..21, oder 1 bei ungueltiger Eingabe (kein throw)
 */
function contrastRatioOnWhite(hex) {
  const rgb = parseCanonicalHex(typeof hex === 'string' ? hex.toLowerCase() : hex);
  if (!rgb) return 1;
  const l1 = relativeLuminance({ r: 255, g: 255, b: 255 });
  const l2 = relativeLuminance(rgb);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function toHexCanonical(r, g, b) {
  const hx = (n) => n.toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/**
 * Parst eine (bereits grob validierte) Farbangabe in {r,g,b} 0..255.
 * Akzeptiert NUR '#rgb', '#rrggbb', 'rgb(r,g,b)' mit dezimalen 0..255-Werten.
 * @param {string} input
 * @returns {{r:number,g:number,b:number}|null}
 */
function parseStrict(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hex3 = HEX3_RE.exec(trimmed);
  if (hex3) {
    const r = parseInt(hex3[1] + hex3[1], 16);
    const g = parseInt(hex3[2] + hex3[2], 16);
    const b = parseInt(hex3[3] + hex3[3], 16);
    return { r, g, b };
  }

  const hex6 = HEX6_RE.exec(trimmed);
  if (hex6) {
    const int = parseInt(hex6[1], 16);
    return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
  }

  const rgb = RGB_RE.exec(trimmed);
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    if (r > 255 || g > 255 || b > 255) return null;
    return { r, g, b };
  }

  return null;
}

/**
 * Dunkelt {r,g,b} deterministisch Richtung Schwarz ab, bis der Kontrast
 * gegen Weiss >=4.5:1 ist. Skalierung in 2%-Schritten, max. 50 Iterationen.
 * @param {{r:number,g:number,b:number}} rgb
 * @returns {{r:number,g:number,b:number}}
 */
function darkenUntilContrast(rgb) {
  let current = rgb;
  let factor = 1;
  for (let i = 0; i < 50; i += 1) {
    const hex = toHexCanonical(current.r, current.g, current.b);
    if (contrastRatioOnWhite(hex) >= 4.5) return current;
    factor -= 0.02;
    if (factor < 0) factor = 0;
    current = {
      r: Math.round(rgb.r * factor),
      g: Math.round(rgb.g * factor),
      b: Math.round(rgb.b * factor),
    };
  }
  return current;
}

/**
 * Strikte Farbnormalisierung. Akzeptiert AUSSCHLIESSLICH:
 *   '#rgb' | '#rrggbb' | 'rgb(r,g,b)' mit r,g,b in 0..255 (dezimal, keine %,
 *   kein Alpha). Alles andere (Farbnamen, hsl(), var(), calc(), url(),
 *   Leerstring) => null.
 * Ergebnis wird bei Kontrast <4.5:1 gegen Weiss deterministisch abgedunkelt.
 *
 * Hinweis: Die Akzentfarbe #1D6FE8 liegt mit ca. 4,68:1 nur knapp ueber der
 * Schwelle 4,5:1 - kuenftige Aufhellungen dieser Farbe wuerden die NFR
 * (Mindestkontrast) brechen. Nicht weiter aufhellen ohne erneute Pruefung.
 *
 * @param {string} input
 * @returns {string|null} kanonisch kleingeschriebenes '#rrggbb' oder null
 */
function normalizeColor(input) {
  const rgb = parseStrict(input);
  if (!rgb) return null;
  const darkened = darkenUntilContrast(rgb);
  return toHexCanonical(darkened.r, darkened.g, darkened.b);
}

// Erlaubte Deklaration im style-Attribut: ausschliesslich `color`, kein
// !important, keine Funktionsaufrufe. Wert wird separat via normalizeColor
// geprueft, hier nur die Extraktion der Deklaration selbst.

/**
 * Nimmt den Rohwert eines style-Attributs, verwirft ALLE Deklarationen
 * ausser `color`. Auch background-color, background, font-*, position,
 * behavior, expression(...), url(...) werden verworfen.
 * @param {string} styleValue
 * @returns {string|null} z.B. 'color:#15803d' oder null (=> Attribut entfernen)
 */
function sanitizeStyleAttribute(styleValue) {
  if (typeof styleValue !== 'string') return null;
  const value = styleValue.trim();
  if (!value) return null;

  // `color` darf NICHT Teil eines anderen Property-Namens sein (z.B.
  // background-color). Wir zerlegen daher in einzelne Deklarationen anhand
  // von ';' und pruefen jede Deklaration separat auf den exakten Namen.
  const declarations = value.split(';');
  let colorValue = null;
  for (const decl of declarations) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (prop === 'color') {
      colorValue = val;
      break; // erste gueltige color-Deklaration gewinnt
    }
  }
  if (colorValue === null) return null;

  // Zusaetzliche Sicherheitsabsicherung: gefaehrliche Muster explizit
  // verwerfen, auch falls sie sich als (scheinbar gueltiger) Farbwert tarnen.
  const lowerVal = colorValue.toLowerCase();
  if (
    lowerVal.includes('url(') ||
    lowerVal.includes('expression(') ||
    lowerVal.includes('javascript:') ||
    lowerVal.includes('calc(') ||
    lowerVal.includes('var(') ||
    lowerVal.includes('/*')
  ) {
    return null;
  }

  const normalized = normalizeColor(colorValue);
  if (!normalized) return null;
  return `color:${normalized}`;
}

// Sehr eng gefasst: <font color="..."> ... </font> oder <font color='...'>.
// Keine verschachtelten Quantifizierer, Attributwert einfach begrenzt.
const FONT_TAG_RE = /<font\b([^>]*)>/gi;
const FONT_CLOSE_RE = /<\/font\s*>/gi;
const COLOR_ATTR_RE = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Regex-basierte Vorverarbeitung fuer Blacklist-Kontexte (server.js) und
 * fuer Legacy-Daten: <font color="X"> => <span style="color:#..."> (bzw. Tag
 * entfernt, wenn X nicht normalisierbar), und normalisiert jedes
 * style="..."-Attribut ueber sanitizeStyleAttribute. Kein Ersatz fuer
 * Allowlist-Sanitizing.
 * @param {string} html
 * @returns {string}
 */
function normalizeInlineColorsInHtml(html) {
  if (typeof html !== 'string') return '';
  let out = html;

  // 1) <font color="X">...</font> -> <span style="color:#...">...</span>
  //    Bei nicht normalisierbarer Farbe: NEUTRALISIEREN statt entfernen
  //    (Security-Nachbesserung). Ein ersatzlos geloeschtes Tag wuerde die
  //    Zeichen davor/danach im String zusammenwachsen lassen - genau das
  //    ermoeglichte einen verifizierten Bypass in stripUnsafeHtml (z.B.
  //    "on<font color=q>error=" -> "onerror=" nach dem Loeschen). Ein
  //    neutrales <span> ohne style haelt die Tag-Grenze aufrecht, sodass
  //    aus zwei ursprad getrennten Tokens nie eines werden kann.
  out = out.replace(FONT_TAG_RE, (full, attrs) => {
    const m = COLOR_ATTR_RE.exec(attrs || '');
    const raw = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    const normalized = normalizeColor(raw);
    if (!normalized) return '<span>';
    return `<span style="color:${normalized}">`;
  });
  // Jedes </font> konsistent auf </span> mappen (jedes <font> wurde oben
  // immer zu <span>, nie geloescht).
  out = out.replace(FONT_CLOSE_RE, '</span>');

  // 2) style="..." Attribute normalisieren (nur color durchlassen).
  out = out.replace(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (full, dq, sq) => {
    const raw = dq !== undefined ? dq : sq;
    const sanitized = sanitizeStyleAttribute(raw);
    if (!sanitized) return '';
    return `style="${sanitized}"`;
  });

  return out;
}

/**
 * '#15803d' -> '15803D' (docx erwartet Hex ohne '#', Grossbuchstaben).
 * @param {string} hex
 * @returns {string}
 */
function toDocxColor(hex) {
  if (typeof hex !== 'string') return '';
  const trimmed = hex.trim();
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  return withoutHash.toUpperCase();
}

module.exports = {
  PALETTE,
  contrastRatioOnWhite,
  normalizeColor,
  sanitizeStyleAttribute,
  normalizeInlineColorsInHtml,
  toDocxColor,
};
