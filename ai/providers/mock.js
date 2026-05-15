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
  theme_tagging:  { suggestions: [] },
  digest:         { summary: 'Mock-Digest.' },
  cross_meeting:  { matches: [] },
  drift:          { drifted: [] },
  test:           'OK',
};

async function callModel({ feature, json = false, maxTokens = 1024 }) {
  const f = feature || 'test';
  let content = FIXTURES[f] != null ? FIXTURES[f] : 'OK';
  if (json && typeof content !== 'string') content = JSON.stringify(content);
  if (!json && typeof content !== 'string') content = String(content);
  return { content, inputTokens: 50, outputTokens: 50 };
}

async function testConnection() {
  return { ok: true, model: 'mock', sample: 'OK' };
}

module.exports = { callModel, testConnection };
