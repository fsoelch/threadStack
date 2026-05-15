'use strict';

// Azure OpenAI: same SDK, different base URL + api-version + key header.
function getClient({ apiKey, endpoint, apiVersion, model }) {
  const OpenAI = require('openai');
  const Ctor = OpenAI.default || OpenAI;
  if (!endpoint)   throw httpErr(409, 'Azure-Endpoint nicht konfiguriert');
  if (!apiVersion) throw httpErr(409, 'Azure-API-Version nicht konfiguriert');
  const baseURL = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(model)}`;
  return new Ctor({
    apiKey,
    baseURL,
    defaultQuery: { 'api-version': apiVersion },
    defaultHeaders: { 'api-key': apiKey },
  });
}

async function callModel({ system, user, maxTokens = 1024, json = false, apiKey, model, azureEndpoint, azureApiVersion }) {
  if (!apiKey) throw httpErr(409, 'kein API-Key konfiguriert');
  if (!model)  throw httpErr(409, 'kein Modell/Deployment konfiguriert');
  const client = getClient({ apiKey, endpoint: azureEndpoint, apiVersion: azureApiVersion, model });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const params = {
    model,
    messages,
    max_completion_tokens: maxTokens,
  };
  if (json) params.response_format = { type: 'json_object' };

  const resp = await withTimeout(client.chat.completions.create(params), 30_000);
  const text = resp.choices?.[0]?.message?.content?.trim() || '';
  return {
    content: text,
    inputTokens:  resp.usage?.prompt_tokens     || 0,
    outputTokens: resp.usage?.completion_tokens || 0,
  };
}

async function testConnection({ apiKey, model, azureEndpoint, azureApiVersion }) {
  const r = await callModel({
    system: 'Reply with literally "OK".',
    user:   'OK',
    maxTokens: 4,
    apiKey, model, azureEndpoint, azureApiVersion,
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
