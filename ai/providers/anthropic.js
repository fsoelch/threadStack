'use strict';

// Lazy import to keep cold-start lean.
function getClient(apiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic.default ? new Anthropic.default({ apiKey }) : new Anthropic({ apiKey });
}

async function callModel({ system, user, maxTokens = 1024, json = false, apiKey, model }) {
  if (!apiKey) throw httpErr(409, 'kein API-Key konfiguriert');
  if (!model)  throw httpErr(409, 'kein Modell konfiguriert');
  const client = getClient(apiKey);
  const sys = json
    ? (system || '') + '\n\nGib ausschließlich gültiges JSON ohne Markdown-Codeblock-Wrapping aus.'
    : (system || '');
  const resp = await withTimeout(
    client.messages.create({
      model,
      max_tokens: maxTokens,
      system: sys,
      messages: [{ role: 'user', content: user }],
    }),
    30_000
  );
  const text = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text).join('').trim();
  return {
    content: text,
    inputTokens:  resp.usage?.input_tokens  || 0,
    outputTokens: resp.usage?.output_tokens || 0,
  };
}

async function testConnection({ apiKey, model }) {
  const r = await callModel({
    system: 'Reply with literally "OK".',
    user:   'OK',
    maxTokens: 4,
    apiKey, model,
  });
  return { ok: true, model, sample: r.content.slice(0, 16) };
}

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      const e = new Error('Provider-Timeout');
      e.httpStatus = 503;
      reject(e);
    }, ms);
    promise.then(v => { clearTimeout(to); resolve(v); },
                 e => { clearTimeout(to); e.httpStatus = e.httpStatus || 503; reject(e); });
  });
}

module.exports = { callModel, testConnection };
