'use strict';
// Baut docx-Inline-Objekte (TextRun/ExternalHyperlink) aus Inline-DOM-Knoten
// (siehe export/html/parse.js). Formatierungen (fett/kursiv/unterstrichen/
// durchgestrichen/Farbe) werden entlang verschachtelter Tags akkumuliert,
// nicht ueberschrieben.

const { TextRun, ExternalHyperlink } = require('docx');
const { normalizeColor, toDocxColor } = require('../../lib/colors');
const { FONT_MONO, COLOR } = require('../docxTheme');

// Schutz gegen pathologisch tiefe Inline-Verschachtelung (z.B. <span><span>...)
// - unabhaengig vom Block-Rekursionsschutz im RenderContext, da Inline-Runs
// rein rekursiv ohne ctx.child()-Tiefenzaehlung gebaut werden.
const MAX_INLINE_DEPTH = 40;

// Nur http:, https:, mailto: (case-insensitive) sind als klickbarer Link
// zulaessig - niemals javascript:/data:/vbscript:/relative Pfade o.ae.
const LINK_SCHEME_RE = /^(https?:|mailto:)/i;

/**
 * Rekursiv der reine Textinhalt eines Knotens (fuer Leer-/Gueltigkeitschecks).
 * @param {object} node
 * @returns {string}
 */
function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return typeof node.data === 'string' ? node.data : '';
  if (!Array.isArray(node.children)) return '';
  return node.children.map(textOf).join('');
}

/**
 * Extrahiert den Rohwert der `color`-Deklaration aus einem style-Attribut.
 * Reine Extraktion (kein Farb-Parsing) - die eigentliche Validierung liegt
 * ausschliesslich bei lib/colors.js#normalizeColor.
 * @param {string} styleAttr
 * @returns {string|null}
 */
function extractStyleColor(styleAttr) {
  if (typeof styleAttr !== 'string' || !styleAttr) return null;
  const declarations = styleAttr.split(';');
  for (const decl of declarations) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    if (prop === 'color') {
      const val = decl.slice(idx + 1).trim();
      return val || null;
    }
  }
  return null;
}

/**
 * Ermittelt (falls vorhanden) die docx-taugliche Farbe eines Tag-Knotens aus
 * `style="color:..."` (bevorzugt) oder Legacy `<font color="...">`.
 * @param {object} node
 * @param {function(string):void} warn
 * @returns {string|null} docx-Hex ohne '#' oder null
 */
function resolveNodeColor(node, warn) {
  if (!node || node.type !== 'tag') return null;
  const attribs = node.attribs || {};
  let raw = null;
  if (node.name === 'font' && typeof attribs.color === 'string' && attribs.color.trim()) {
    raw = attribs.color.trim();
  }
  const styleColor = extractStyleColor(attribs.style);
  if (styleColor) raw = styleColor; // style hat Vorrang, falls beides vorhanden
  if (!raw) return null;

  const normalized = normalizeColor(raw);
  if (!normalized) {
    warn('COLOR_REJECTED');
    return null;
  }
  return toDocxColor(normalized);
}

/**
 * Erzeugt an einen Warn-Callback gebundene Inline-Hilfsfunktionen. Wird vom
 * htmlToDocx-Facade einmal pro Export-Aufruf erzeugt und dem RenderContext
 * als Dependency Injection uebergeben (siehe export/html/context.js).
 * @param {function(string):void} [warnFn]
 * @returns {{buildInlineRuns: function, inlineRunsOf: function}}
 */
function createInlineHelpers(warnFn) {
  const warn = typeof warnFn === 'function' ? warnFn : () => {};

  /**
   * Baut Inline-Runs fuer `node` (Text oder Tag) unter Uebernahme/Erweiterung
   * von `style` und pusht sie nach `out`. Wirft nie.
   * @param {object} node
   * @param {object} style akkumulierte TextRun-Optionen (bold/italics/...)
   * @param {Array} out Zielarray
   * @param {number} [depth=0] interner Rekursionszaehler (Inline-Schutz)
   */
  function buildInlineRuns(node, style, out, depth) {
    if (!node || !Array.isArray(out)) return;
    const d = Number.isInteger(depth) ? depth : 0;

    if (node.type === 'text') {
      if (node.data) out.push(new TextRun({ text: node.data, ...(style || {}) }));
      return;
    }
    if (node.type !== 'tag') return;
    if (d > MAX_INLINE_DEPTH) {
      warn('DEPTH_LIMIT');
      return;
    }

    const tag = node.name;
    const nextStyle = { ...(style || {}) };

    if (tag === 'strong' || tag === 'b') nextStyle.bold = true;
    else if (tag === 'em' || tag === 'i') nextStyle.italics = true;
    else if (tag === 'u') nextStyle.underline = {};
    else if (tag === 's' || tag === 'strike' || tag === 'del') nextStyle.strike = true;
    else if (tag === 'br') {
      out.push(new TextRun({ text: '', break: 1 }));
      return;
    } else if (tag === 'code') {
      // Inline-Code: nur Monospace-Font, KEINE Hintergrundfarbe (das ist
      // ausschliesslich Block-`pre`, siehe export/html/blocks.js).
      nextStyle.font = FONT_MONO;
    }

    const color = resolveNodeColor(node, warn);
    if (color) nextStyle.color = color;

    if (tag === 'a') {
      buildAnchor(node, nextStyle, style || {}, out, d);
      return;
    }

    for (const child of node.children || []) buildInlineRuns(child, nextStyle, out, d + 1);
  }

  /**
   * Behandelt `<a href>`: gueltiges Schema (http/https/mailto) UND
   * sichtbarer Text -> ExternalHyperlink mit Akzentfarbe+Unterstreichung.
   * Sonst -> HYPERLINK_INVALID-Warnung, Text als normaler Fliesstext (mit dem
   * urspruenglichen, nicht-link-spezifischen Style).
   */
  function buildAnchor(node, linkStyle, fallbackStyle, out, depth) {
    const attribs = node.attribs || {};
    const href = typeof attribs.href === 'string' ? attribs.href.trim() : '';
    const validScheme = LINK_SCHEME_RE.test(href);
    const hasText = textOf(node).trim().length > 0;

    if (validScheme && hasText) {
      const styledLink = { ...linkStyle, color: COLOR.accent, underline: {} };
      const children = [];
      for (const child of node.children || []) buildInlineRuns(child, styledLink, children, depth + 1);
      if (children.length) {
        out.push(new ExternalHyperlink({ link: href, children }));
        return;
      }
    }

    warn('HYPERLINK_INVALID');
    for (const child of node.children || []) buildInlineRuns(child, fallbackStyle, out, depth + 1);
  }

  /**
   * Baut aus einer Liste von Inline-Kindknoten ein neues Array von Runs.
   * @param {Array<object>} nodes
   * @param {object} [style]
   * @returns {Array}
   */
  function inlineRunsOf(nodes, style) {
    const out = [];
    if (!Array.isArray(nodes)) return out;
    for (const node of nodes) buildInlineRuns(node, style || {}, out, 0);
    return out;
  }

  return { buildInlineRuns, inlineRunsOf };
}

module.exports = { createInlineHelpers, textOf };
