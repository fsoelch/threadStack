'use strict';

// Deterministic mock provider activated via AI_PROVIDER_OVERRIDE=mock.
// Used by the test suite — never invoked in production.

const FIXTURES = {
  brief: {
    talking_points: ['Punkt A', 'Punkt B'],
    open_issues:    ['Offen 1', 'Offen 2'],
    history:        'Vorgeschichte (mock).',
  },
  capture: {
    new_topics:    [{ title: 'Mock-Thema',  description: 'Aus Notizen extrahiert.' }],
    topic_results: [],
    new_todos:     [{ title: 'Mock-Todo',   description: '' }],
    theme_links:   [],
  },
  result_draft:   'Mock-Ergebnistext.',
  reentry:        'Mock-Reentry-Briefing.',
  theme_tagging:  { matches: [] },           // wird in tests pro Test überschrieben
  digest:         {
    summary:    'Mock-Digest der Woche.',
    highlights: ['Highlight 1', 'Highlight 2'],
    focus_next: ['Fokus 1', 'Fokus 2'],
  },
  cross_meeting:  { matches: [] },
  drift:          { drifted: [] },
  link_summary:   'Mock-Zusammenfassung.',
  test:           'OK',
};

// Allows tests to override the response for a specific feature.
function setMockResponse(feature, value) { FIXTURES[feature] = value; }

// Records the parameters of the most recent callModel invocation, so tests
// can assert on things (e.g. maxTokens, prompt content) that don't show up
// in the returned content itself. Additive, non-breaking: existing tests
// that never call getLastCall() are unaffected.
let lastCall = null;
function getLastCall() { return lastCall; }

async function callModel({ feature, json = false, maxTokens = 1024, system, user }) {
  const f = feature || 'test';
  lastCall = { feature: f, json, maxTokens, system, user };
  let content = FIXTURES[f] != null ? FIXTURES[f] : 'OK';
  if (json && typeof content !== 'string') content = JSON.stringify(content);
  if (!json && typeof content !== 'string') content = String(content);
  return { content, inputTokens: 50, outputTokens: 50 };
}

async function testConnection() {
  return { ok: true, model: 'mock', sample: 'OK' };
}

module.exports = { callModel, testConnection, setMockResponse, getLastCall };
