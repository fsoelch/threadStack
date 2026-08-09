'use strict';
// Extrahiert lesbaren Klartext aus einem HTML-Buffer (Antwort von
// lib/safe-fetch.js). Nutzt htmlparser2 im Streaming-Modus (wie bereits in
// export/htmlToDocx.js verwendet) statt eines DOM-Parsers, damit bei
// Erreichen von `maxChars` abgebrochen werden kann, ohne den ganzen
// Dokumentbaum aufzubauen bzw. weiter zu parsen.
const { Parser } = require('htmlparser2');

const MAX_TITLE_CHARS = 300;

class ExtractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ExtractError';
    this.code = code;
  }
}

// Tags, deren gesamter Inhalt verworfen wird (nicht nur der Tag selbst).
const DISCARD_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg',
  'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select',
]);

// Blockelemente: erzeugen eine Zeilenumbruch-Trennung im extrahierten Text.
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'br', 'tr', 'section', 'article',
]);

// Sentinel zum kooperativen, frühzeitigen Abbruch des Streaming-Parsers,
// sobald maxChars erreicht ist (statt weiter zu parsen/aufzubauen).
const STOP_PARSING = Symbol('stop-parsing');

// Sucht `<meta charset="...">` bzw. `<meta http-equiv="Content-Type"
// content="...charset=...">` in den ersten 2 KB des Roh-Buffers (Latin1
// reicht für dieses rein ASCII-basierte Tag-Muster, unabhängig von der
// eigentlichen Dokument-Kodierung).
function detectMetaCharset(buffer) {
  const head = buffer.subarray(0, 2048).toString('latin1');
  let m = head.match(/<meta\b[^>]*\bcharset\s*=\s*["']?([a-zA-Z0-9_-]+)/i);
  if (m) return m[1];
  m = head.match(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']content-type["'][^>]*\bcontent\s*=\s*["'][^"']*charset=([a-zA-Z0-9_-]+)/i);
  if (m) return m[1];
  return '';
}

function decodeBuffer(buffer, charsetParam) {
  const charset = charsetParam || detectMetaCharset(buffer) || 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    // Unbekanntes/nicht unterstütztes Charset-Label -> UTF-8-Fallback.
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function normalizeFinalText(raw) {
  return raw
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extrahiert Titel, lesbaren Text und Sprache aus einem HTML-Buffer.
 * Wirft ExtractError('no_text_content'), wenn nach der Extraktion weniger
 * als 200 Zeichen (getrimmt) übrig bleiben.
 */
function extractReadableText(buffer, options = {}) {
  const { charset = '', maxChars = 12000 } = options;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const html = decodeBuffer(buf, charset);

  let discardDepth = 0;
  let inTitle = false;
  let titleRaw = '';
  let ogTitle = '';
  let lang = '';
  let out = '';
  let truncated = false;

  function append(str) {
    if (!str) return;
    out += str;
    if (out.length >= maxChars) {
      out = out.slice(0, maxChars);
      truncated = true;
      throw STOP_PARSING;
    }
  }

  const parser = new Parser({
    onopentag(name, attribs) {
      const tag = String(name).toLowerCase();

      if (tag === 'html') {
        const l = String((attribs && attribs.lang) || '').trim().toLowerCase();
        if (l.startsWith('de')) lang = 'de';
        else if (l.startsWith('en')) lang = 'en';
      }
      if (tag === 'meta' && attribs) {
        const prop = String(attribs.property || attribs.name || '').toLowerCase();
        if (prop === 'og:title' && attribs.content) ogTitle = attribs.content;
      }

      if (DISCARD_TAGS.has(tag)) {
        discardDepth += 1;
        return;
      }
      if (discardDepth > 0) return;

      if (tag === 'title') {
        inTitle = true;
        return;
      }
      if (BLOCK_TAGS.has(tag)) append('\n');
    },
    ontext(text) {
      if (discardDepth > 0) return;
      if (inTitle) {
        titleRaw += text;
        return;
      }
      const normalized = text.replace(/\s+/g, ' ');
      append(normalized);
    },
    onclosetag(name) {
      const tag = String(name).toLowerCase();

      if (DISCARD_TAGS.has(tag)) {
        discardDepth = Math.max(0, discardDepth - 1);
        return;
      }
      if (discardDepth > 0) return;

      if (tag === 'title') {
        inTitle = false;
        return;
      }
      if (BLOCK_TAGS.has(tag)) append('\n');
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });

  try {
    parser.write(html);
    parser.end();
  } catch (err) {
    if (err !== STOP_PARSING) throw err;
  }

  const text = normalizeFinalText(out);

  let title = titleRaw.replace(/\s+/g, ' ').trim();
  if (!title) title = String(ogTitle || '').replace(/\s+/g, ' ').trim();
  title = title.slice(0, MAX_TITLE_CHARS);

  if (text.trim().length < 200) {
    throw new ExtractError('no_text_content', 'Auf der Seite wurde kein ausreichender lesbarer Text gefunden.');
  }

  return { title, text, lang, truncated };
}

module.exports = { extractReadableText, ExtractError };
