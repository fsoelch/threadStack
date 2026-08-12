'use strict';
// Allowlist-basiertes Sanitizing für Wissensinhalte (Knowledge-Content).
//
// Bewusst getrennt von server.js' bestehendem `stripUnsafeHtml` (blacklist-basiert,
// bleibt für alle anderen Felder unverändert). Für Knowledge-Content reicht eine
// Blacklist nicht aus (z. B. <style>-Tags und entity-kodierte javascript:-Schemata
// passieren stripUnsafeHtml) — deshalb hier eine echte Allowlist via `sanitize-html`.
const sanitizeHtml = require('sanitize-html');
const { sanitizeStyleAttribute, normalizeInlineColorsInHtml } = require('./colors');

const MAX_KNOWLEDGE_CONTENT = 500000;

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
  'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'hr', 'span', 'div',
];

// Tags fuer die ein `style`-Attribut erlaubt ist - ausschliesslich fuer die
// Textfarbe (siehe `allowedStyles` unten sowie `sanitizeStyleAttribute` in
// lib/colors.js, die zusaetzlich JEDE andere Deklaration verwirft).
const STYLE_ALLOWED_TAGS = [
  'span', 'p', 'div', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4',
  'strong', 'b', 'em', 'i', 'u', 's', 'a', 'code', 'blockquote',
];

// Defense-in-Depth zusaetzlich zu `allowedStyles`: jedes ueberlebende
// style-Attribut wird nochmals durch sanitizeStyleAttribute gefiltert
// (strikte Allowlist: nur `color`, nur Hex/rgb). Wird per transformTags auf
// jeden STYLE_ALLOWED_TAGS-Eintrag angewendet.
function styleSanitizingTransform(tagName) {
  return (name, attribs) => {
    const newAttribs = Object.assign({}, attribs);
    if (newAttribs.style !== undefined) {
      const sanitized = sanitizeStyleAttribute(newAttribs.style);
      if (sanitized) {
        newAttribs.style = sanitized;
      } else {
        delete newAttribs.style;
      }
    }
    return { tagName: name, attribs: newAttribs };
  };
}

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
  // Legacy-<font color>-Markup (auch aus alten DB-Eintraegen) sowie jedes
  // rohe style-Attribut vorab normalisieren, BEVOR der Allowlist-Sanitizer
  // greift - siehe lib/colors.js.
  const withNormalizedColors = normalizeInlineColorsInHtml(withHrefScheme);

  const styleAllowedAttributes = {};
  for (const tag of STYLE_ALLOWED_TAGS) {
    styleAllowedAttributes[tag] = ['style'];
  }

  return sanitizeHtml(withNormalizedColors, {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: DISCARD_CONTENT_TAGS,
    allowedAttributes: {
      ...styleAllowedAttributes,
      a: ['href', 'title', 'rel', 'target', 'style'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan', 'style'],
      th: ['colspan', 'rowspan', 'style'],
    },
    // Nur `color` als Hex/rgb wird ueberhaupt als Deklaration akzeptiert -
    // alles andere (background-color, font-size, position, expression(...),
    // url(...) etc.) wird von sanitize-html selbst bereits verworfen.
    allowedStyles: {
      '*': {
        color: [
          /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
          /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
        ],
      },
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
      a: (name, attribs) => {
        const merged = Object.assign({}, attribs, {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        });
        if (merged.style !== undefined) {
          const sanitized = sanitizeStyleAttribute(merged.style);
          if (sanitized) {
            merged.style = sanitized;
          } else {
            delete merged.style;
          }
        }
        return { tagName: 'a', attribs: merged };
      },
      span: styleSanitizingTransform('span'),
      p: styleSanitizingTransform('p'),
      div: styleSanitizingTransform('div'),
      li: styleSanitizingTransform('li'),
      td: styleSanitizingTransform('td'),
      th: styleSanitizingTransform('th'),
      h1: styleSanitizingTransform('h1'),
      h2: styleSanitizingTransform('h2'),
      h3: styleSanitizingTransform('h3'),
      h4: styleSanitizingTransform('h4'),
      strong: styleSanitizingTransform('strong'),
      b: styleSanitizingTransform('b'),
      em: styleSanitizingTransform('em'),
      i: styleSanitizingTransform('i'),
      u: styleSanitizingTransform('u'),
      s: styleSanitizingTransform('s'),
      code: styleSanitizingTransform('code'),
      blockquote: styleSanitizingTransform('blockquote'),
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
