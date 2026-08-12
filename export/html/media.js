'use strict';

/**
 * Baut die docx-Bloecke fuer ein <img>-Element aus sanitiztem Knowledge-HTML.
 *
 * Nur `data:image/(png|jpeg|jpg|gif|bmp);base64,...`-URLs werden eingebettet.
 * Alles andere (externe URLs, webp, unbekannte/fehlerhafte Formate, korruptes
 * Base64, nicht lesbare Bildmasse) fuehrt zu einem sauberen, kursiven
 * Platzhalter-Absatz statt zu einem verzerrten oder inkonsistenten Bild.
 *
 * WICHTIG (Sicherheits-/Kompatibilitaets-Fix): `docx` v9 akzeptiert fuer
 * ImageRun ausschliesslich die Typen 'jpg'|'png'|'gif'|'bmp'. WebP-Bytes
 * werden NIE unter einem anderen Typ (z.B. faelschlich 'png') durchgereicht,
 * da das eine inkonsistente Mediendatei erzeugt und Word beim Oeffnen zu
 * Reparaturhinweisen fuehrt.
 */

const { Paragraph, TextRun, ImageRun } = require('docx');
const { imageSize } = require('../imageSize');
const { PAGE } = require('../docxTheme');

// Erlaubte MIME-Typen fuer eingebettete data-URL-Bilder (case-insensitive).
// 'webp' und alles andere fallen bewusst NICHT hierunter.
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,(.+)$/i;

// docx erwartet fuer ImageRun.type genau 'jpg'|'png'|'gif'|'bmp'.
const MIME_TO_DOCX_TYPE = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  bmp: 'bmp',
};

// Nur "reines" Base64 (kein Data-URL-Praefix mehr) gilt als decodierbar.
// Whitespace innerhalb der Daten (z.B. durch Zeilenumbrueche) wird toleriert
// und vor der Pruefung entfernt.
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * @param {{name:'img', attribs:{src?:string, alt?:string, width?:string, height?:string}}} node
 * @param {object} ctx RenderContext (siehe export/html/context.js)
 * @returns {Array} IMMER genau 1 Paragraph.
 */
function buildImageBlocks(node, ctx) {
  const attribs = (node && typeof node === 'object' && node.attribs && typeof node.attribs === 'object')
    ? node.attribs
    : {};
  const alt = typeof attribs.alt === 'string' ? attribs.alt.trim() : '';

  try {
    return buildEmbeddedImage(attribs, alt, ctx);
  } catch {
    // Verteidigungslinie: buildImageBlocks darf NIE werfen.
    return [placeholderParagraph(alt)];
  }
}

/**
 * @param {object} attribs
 * @param {string} alt bereits getrimmter alt-Text
 * @param {object} ctx
 * @returns {Array} Paragraph[]
 */
function buildEmbeddedImage(attribs, alt, ctx) {
  const src = typeof attribs.src === 'string' ? attribs.src : '';

  const match = DATA_IMAGE_RE.exec(src);
  if (!match) {
    warn(ctx, 'IMG_UNSUPPORTED_FORMAT');
    return [placeholderParagraph(alt)];
  }

  let mime = match[1].toLowerCase();
  const base64Data = match[2].replace(/\s+/g, '');
  const dockType = MIME_TO_DOCX_TYPE[mime];
  if (!dockType) {
    // Sollte durch die Regex bereits ausgeschlossen sein, aber defensiv
    // trotzdem behandeln statt eine falsche Typangabe durchzureichen.
    warn(ctx, 'IMG_UNSUPPORTED_FORMAT');
    return [placeholderParagraph(alt)];
  }

  if (!BASE64_CHARS_RE.test(base64Data) || base64Data.length === 0) {
    warn(ctx, 'IMG_DECODE_FAILED');
    return [placeholderParagraph(alt)];
  }

  let buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch {
    warn(ctx, 'IMG_DECODE_FAILED');
    return [placeholderParagraph(alt)];
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    warn(ctx, 'IMG_DECODE_FAILED');
    return [placeholderParagraph(alt)];
  }

  const intrinsic = imageSize(buffer);
  if (!intrinsic) {
    warn(ctx, 'IMG_DIMENSIONS_UNKNOWN');
    return [placeholderParagraph(alt)];
  }

  const { width, height } = resolveTargetSize(attribs, intrinsic);

  try {
    const altText = alt || 'Bild';
    const imageRun = new ImageRun({
      type: dockType,
      data: buffer,
      transformation: { width, height },
      altText: {
        name: altText,
        description: alt || 'Bild aus ThreadStack-Export',
        title: altText,
      },
    });
    return [new Paragraph({ children: [imageRun] })];
  } catch {
    warn(ctx, 'IMG_DECODE_FAILED');
    return [placeholderParagraph(alt)];
  }
}

/**
 * Ermittelt die seitenverhaeltnistreuen Zielmasse (Pixel) fuer die
 * Einbettung, gemaess der in der Architektur festgelegten Prioritaet:
 * 1) HTML-width/height-Attribute, sofern beide als Pixelwert lesbar sind UND
 *    die Breite die Satzspiegelbreite nicht ueberschreitet.
 * 2) Sonst die intrinsischen Bildmasse.
 * In beiden Faellen wird proportional auf die Satzspiegelbreite
 * herunterskaliert, falls die ermittelte Breite sie ueberschreitet.
 * Kleinere Bilder werden NIE vergroessert.
 *
 * @param {object} attribs
 * @param {{width:number, height:number}} intrinsic
 * @returns {{width:number, height:number}}
 */
function resolveTargetSize(attribs, intrinsic) {
  const contentWidthPx = PAGE.contentWidthPx;

  const attrWidth = parsePixelAttr(attribs.width);
  const attrHeight = parsePixelAttr(attribs.height);

  let width;
  let height;
  if (attrWidth && attrHeight && attrWidth <= contentWidthPx) {
    width = attrWidth;
    height = attrHeight;
  } else {
    width = intrinsic.width;
    height = intrinsic.height;
  }

  if (width > contentWidthPx) {
    const ratio = contentWidthPx / width;
    height = height * ratio;
    width = contentWidthPx;
  }

  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));

  return { width, height };
}

/**
 * Parst ein HTML-width/height-Attribut als reine Pixelzahl ('300' oder
 * '300px'). Alles andere (Prozent, leer, nicht-numerisch) liefert null,
 * damit die Attribut-Vorrangregel nicht faelschlich greift.
 * @param {*} value
 * @returns {number|null}
 */
function parsePixelAttr(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const m = /^(\d+(?:\.\d+)?)(px)?$/i.exec(trimmed);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {string} alt bereits getrimmter alt-Text
 * @returns {Paragraph}
 */
function placeholderParagraph(alt) {
  const text = alt
    ? `[Bild konnte nicht eingebettet werden: ${alt}]`
    : '[Bild konnte nicht eingebettet werden]';
  return new Paragraph({ children: [new TextRun({ text, italics: true })] });
}

/**
 * Ruft ctx.warn(code) defensiv auf (ctx koennte im Test minimal/fehlerhaft
 * sein) -- darf NIE werfen.
 * @param {object} ctx
 * @param {string} code
 */
function warn(ctx, code) {
  try {
    if (ctx && typeof ctx.warn === 'function') ctx.warn(code);
  } catch {
    // Logging darf den Export niemals abbrechen.
  }
}

module.exports = { buildImageBlocks };
