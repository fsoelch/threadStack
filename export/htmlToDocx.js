'use strict';
// Fassade: parst sanitiztes Knowledge-/Todo-HTML zu einer flachen Liste von
// docx-Bloecken (Paragraph/Table). Die eigentliche Parser-/Dispatcher-Logik
// lebt in export/html/{parse,inline,blocks,lists,tables,media}.js.

const { parseHtml } = require('./html/parse');
const { createInlineHelpers } = require('./html/inline');
const { buildBlocks } = require('./html/blocks');
const { createRenderContext } = require('./html/context');
const docxTheme = require('./docxTheme');

/**
 * Normalisiert das zweite Argument: eine Zahl wird als headingBase
 * interpretiert (Rueckwaertskompatibilitaet fuer Bestandsaufrufe), ein
 * Options-Objekt wird direkt uebernommen.
 * @param {number|object} options
 * @returns {object}
 */
function normalizeOptions(options) {
  if (typeof options === 'number') return { headingBase: options };
  if (options && typeof options === 'object') return options;
  return {};
}

/**
 * @param {string} html bereits sanitiztes HTML aus der DB
 * @param {number|{headingBase?:number, numbering?:object, warn?:function}} [options]
 * @returns {Array} (Paragraph|Table)[] - nie null, wirft nie
 */
function htmlToDocxBlocks(html, options) {
  try {
    const opts = normalizeOptions(options);

    const headingBase = Number.isFinite(opts.headingBase) ? opts.headingBase : 5;
    const numbering = opts.numbering && typeof opts.numbering.allocate === 'function'
      ? opts.numbering
      : docxTheme.createNumberingRegistry();
    const warn = typeof opts.warn === 'function' ? opts.warn : () => {};

    const dom = parseHtml(html);
    const { buildInlineRuns, inlineRunsOf } = createInlineHelpers(warn);

    const ctx = createRenderContext({
      headingBase,
      numbering,
      buildBlocks,
      buildInlineRuns,
      inlineRunsOf,
      warn,
      depth: 0,
    });

    return buildBlocks(dom, ctx);
  } catch {
    // Ein Parse-/Renderfehler darf den Export niemals abbrechen.
    return [];
  }
}

module.exports = { htmlToDocxBlocks };
