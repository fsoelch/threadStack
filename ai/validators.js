'use strict';
// JSON-Validierung der Modellantworten (leichtgewichtig, keine Zusatz-
// Abhaengigkeit). Aus ai/index.js extrahiert (Arbeit zur Lesbarkeit/
// Wartbarkeit) - Verhalten unveraendert.

function parseJsonStrict(text) {
  // Strip optional ```json fences just in case the model ignores instructions.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  return JSON.parse(cleaned);
}

const CAPTURE_SCHEMA = {
  new_topics:    'array',
  topic_results: 'array',
  new_todos:     'array',
  theme_links:   'array',
};

function validateCapture(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Top-level must be object');
  for (const k of Object.keys(CAPTURE_SCHEMA)) {
    if (obj[k] == null) obj[k] = [];
    if (!Array.isArray(obj[k])) throw new Error(`${k} must be array`);
  }
  return obj;
}

const BRIEF_SCHEMA = { talking_points: 'array', open_issues: 'array', history: 'string' };
function validateBrief(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Top-level must be object');
  if (!Array.isArray(obj.talking_points)) obj.talking_points = [];
  if (!Array.isArray(obj.open_issues))    obj.open_issues = [];
  if (typeof obj.history !== 'string')    obj.history = String(obj.history || '');
  return obj;
}

const THEME_TAG_SCHEMA = {
  matches: 'array',
};
function validateThemeTagging(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Top-level must be object');
  if (!Array.isArray(obj.matches)) obj.matches = [];
  return obj;
}

const CMI_SCHEMA = { matches: 'array' };
function validateCMI(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Top-level must be object');
  if (!Array.isArray(obj.matches)) obj.matches = [];
  return obj;
}

module.exports = {
  parseJsonStrict,
  CAPTURE_SCHEMA, validateCapture,
  BRIEF_SCHEMA, validateBrief,
  THEME_TAG_SCHEMA, validateThemeTagging,
  CMI_SCHEMA, validateCMI,
};
