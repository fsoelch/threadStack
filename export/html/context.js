'use strict';

/**
 * Render-Kontext fuer den HTML->DOCX-Konverter.
 *
 * Definiert NUR die Kontext-Struktur (Dependency Injection). Die eigentliche
 * Parser-/Dispatcher-Logik (buildBlocks/buildInlineRuns/inlineRunsOf) wird
 * von Paket 2 implementiert und dem Kontext hier lediglich vom Aufrufer
 * uebergeben.
 */

const MAX_DEPTH = 20;
const MAX_BLOCKS = 20000;

/** Abschliessende Liste zulaessiger Warn-Codes (siehe Architektur-Vertrag). */
const WARN_CODES = Object.freeze([
  'IMG_DECODE_FAILED',
  'IMG_UNSUPPORTED_FORMAT',
  'IMG_DIMENSIONS_UNKNOWN',
  'TABLE_MALFORMED',
  'DEPTH_LIMIT',
  'BLOCK_LIMIT',
  'HYPERLINK_INVALID',
  'COLOR_REJECTED',
]);

/**
 * Erzeugt den unveraenderlichen Render-Kontext, den alle Handler bekommen.
 *
 * @param {object} options
 * @param {number} [options.headingBase=5] 1..6, Basis-Heading-Ebene fuer
 *        content-eigene h1-h4.
 * @param {object} options.numbering NumberingRegistry (Pflicht).
 * @param {function} options.buildBlocks (nodes, ctx) => (Paragraph|Table)[]
 * @param {function} options.buildInlineRuns (node, style, out) => void
 * @param {function} options.inlineRunsOf (nodes, style) => (TextRun|ExternalHyperlink)[]
 * @param {function} [options.warn] (code: string) => void (nur Codes, NIE Inhalte)
 * @param {number} [options.depth=0] aktuelle DOM-Verschachtelungstiefe
 * @returns {object} RenderContext
 */
function createRenderContext(options) {
  const opts = options && typeof options === 'object' ? options : {};

  if (!opts.numbering || typeof opts.numbering.allocate !== 'function') {
    throw new TypeError('createRenderContext: numbering (NumberingRegistry) ist Pflicht');
  }

  let headingBase = Number.isInteger(opts.headingBase) ? opts.headingBase : 5;
  if (headingBase < 1) headingBase = 1;
  if (headingBase > 6) headingBase = 6;

  let depth = Number.isInteger(opts.depth) ? opts.depth : 0;
  if (depth < 0) depth = 0;

  const warnFn = typeof opts.warn === 'function' ? opts.warn : () => {};
  /**
   * Wrappt die uebergebene warn-Funktion: gibt ausschliesslich bekannte
   * Codes weiter (nie Nutzinhalte) und schluckt Fehler der Callback-Funktion
   * selbst, damit ein fehlerhafter Logger den Export nicht abbricht.
   * @param {string} code
   */
  function safeWarn(code) {
    if (typeof code !== 'string' || !WARN_CODES.includes(code)) return;
    try {
      warnFn(code);
    } catch {
      // Logging darf den Export niemals abbrechen.
    }
  }

  const ctx = {
    headingBase,
    numbering: opts.numbering,
    buildBlocks: typeof opts.buildBlocks === 'function' ? opts.buildBlocks : undefined,
    buildInlineRuns: typeof opts.buildInlineRuns === 'function' ? opts.buildInlineRuns : undefined,
    inlineRunsOf: typeof opts.inlineRunsOf === 'function' ? opts.inlineRunsOf : undefined,
    warn: safeWarn,
    depth,
    MAX_DEPTH,
    MAX_BLOCKS,
    /**
     * Liefert eine Kopie mit erhoehter Tiefe; wirft nie.
     * @returns {object} RenderContext
     */
    child() {
      return createRenderContext({
        headingBase: ctx.headingBase,
        numbering: ctx.numbering,
        buildBlocks: ctx.buildBlocks,
        buildInlineRuns: ctx.buildInlineRuns,
        inlineRunsOf: ctx.inlineRunsOf,
        warn: warnFn,
        depth: ctx.depth + 1,
      });
    },
  };

  return ctx;
}

module.exports = { createRenderContext, MAX_DEPTH, MAX_BLOCKS, WARN_CODES };
