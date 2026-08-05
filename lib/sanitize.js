'use strict';
// Allowlist-basiertes Sanitizing für Wissensinhalte (Knowledge-Content).
//
// Bewusst getrennt von server.js' bestehendem `stripUnsafeHtml` (blacklist-basiert,
// bleibt für alle anderen Felder unverändert). Für Knowledge-Content reicht eine
// Blacklist nicht aus (z. B. <style>-Tags und entity-kodierte javascript:-Schemata
// passieren stripUnsafeHtml) — deshalb hier eine echte Allowlist via `sanitize-html`.
const sanitizeHtml = require('sanitize-html');

const MAX_KNOWLEDGE_CONTENT = 500000;

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
  'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'span', 'div',
];

const ALLOWED_IMG_DATA_MIME = /^data:image\/(png|jpeg|gif|webp)[;,]/i;

// Tags whose *content* is discarded entirely, not just the tag itself.
const DISCARD_CONTENT_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form'];

// A URL is considered "protocol-relative/absolute enough to leave alone" if it
// already carries a scheme, is protocol-relative, an absolute/relative path,
// an in-page anchor, or a mailto link.
const HAS_EXPLICIT_TARGET_RE = /^([a-z][a-z0-9+.-]*:|\/\/|\/|#|mailto:)/i;

function prefixHrefsWithoutScheme(html) {
  return html.replace(/(\shref\s*=\s*)(["'])([^"']*)\2/gi, (match, prefix, quote, url) => {
    const trimmed = url.trim();
    if (!trimmed) return match;
    if (HAS_EXPLICIT_TARGET_RE.test(trimmed)) return match;
    return `${prefix}${quote}https://${trimmed}${quote}`;
  });
}

/**
 * Sanitizes HTML meant for `knowledge_pages.content` using an allowlist.
 * Non-allowed tags are stripped but their text content is preserved, except
 * for DISCARD_CONTENT_TAGS whose content is dropped entirely.
 */
function sanitizeKnowledgeHtml(html) {
  if (html == null) return '';
  const input = String(html);
  const withHrefScheme = prefixHrefsWithoutScheme(input);

  return sanitizeHtml(withHrefScheme, {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: DISCARD_CONTENT_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      // data: is only further restricted to image mime types below via exclusiveFilter;
      // sanitize-html itself only understands scheme names, not full data: sub-types.
      img: ['http', 'https', 'data'],
    },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }, true),
    },
    exclusiveFilter(frame) {
      if (frame.tag === 'img') {
        const src = frame.attribs && frame.attribs.src;
        if (src && /^data:/i.test(src) && !ALLOWED_IMG_DATA_MIME.test(src)) return true;
      }
      return false;
    },
  });
}

/**
 * Strips all HTML, decodes entities, normalizes whitespace. Only meant for
 * content_text / FTS / snippets — never for direct HTML rendering.
 */
function htmlToText(html) {
  if (html == null) return '';
  const textOnly = sanitizeHtml(String(html), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: DISCARD_CONTENT_TAGS,
  });
  const decoded = textOnly
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
  return decoded.replace(/\s+/g, ' ').trim();
}

module.exports = { sanitizeKnowledgeHtml, htmlToText, MAX_KNOWLEDGE_CONTENT };
