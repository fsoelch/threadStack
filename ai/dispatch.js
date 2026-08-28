'use strict';
const cryptoMod = require('./crypto');
const cost      = require('./cost');
const usage     = require('./usage');
const { httpErr } = require('./errors');
const { parseJsonStrict } = require('./validators');

// ── Provider registry ────────────────────────────────────────
// Aus ai/index.js extrahiert (Arbeit zur Lesbarkeit/Wartbarkeit) - Verhalten
// unveraendert.
const PROVIDERS = {
  anthropic: require('./providers/anthropic'),
  openai:    require('./providers/openai'),
  azure:     require('./providers/azure'),
  mock:      require('./providers/mock'),
};

function pickProvider(name) {
  if (process.env.AI_PROVIDER_OVERRIDE === 'mock') return PROVIDERS.mock;
  const p = PROVIDERS[name];
  if (!p) throw httpErr(409, `Unbekannter Provider: ${name}`);
  return p;
}

// ── Gating helpers ───────────────────────────────────────────
function assertActive(settings, feature) {
  if (!settings)                  throw httpErr(409, 'AI nicht konfiguriert');
  if (settings.globally_disabled) throw httpErr(409, 'AI ist deaktiviert');
  if (!settings.provider)         throw httpErr(409, 'kein Provider konfiguriert');
  if (!settings.api_key_encrypted)throw httpErr(409, 'kein API-Key konfiguriert');
  if (feature && !settings.features_enabled[feature]) {
    throw httpErr(409, `Feature "${feature}" ist deaktiviert`);
  }
}

// ── Core dispatch ────────────────────────────────────────────
async function dispatchCall({ db, userId, settings, encryptionKey, feature, system, user, maxTokens, json, confirmed }) {
  const provider = pickProvider(settings.provider);
  const model    = settings.model;
  const isMock   = process.env.AI_PROVIDER_OVERRIDE === 'mock' || settings.provider === 'mock';

  // Estimate before sending
  const estimate = cost.estimateBeforeCall({
    model, feature, promptText: (system || '') + '\n' + (user || ''),
  });

  // Budget + confirm gating
  usage.assertBudgetOk(db, userId, settings, estimate.cost_cents);
  usage.assertConfirmedIfExpensive(settings, estimate.cost_cents, confirmed);

  // Decrypt API key just-in-time, never log
  const apiKey = isMock
    ? 'mock'
    : cryptoMod.decryptKey(settings.api_key_encrypted, encryptionKey);

  let raw;
  try {
    raw = await provider.callModel({
      system, user, maxTokens, json,
      apiKey, model,
      azureEndpoint:   settings.azure_endpoint,
      azureApiVersion: settings.azure_api_version,
      feature,
    });
  } catch (e) {
    if (!e.httpStatus) e.httpStatus = 503;
    throw e;
  }

  // Log actual usage with provider-reported tokens when available.
  const realCost = cost.estimateCostCents({
    model,
    inputTokens:  raw.inputTokens  || estimate.inputTokens,
    outputTokens: raw.outputTokens || estimate.outputTokens,
  });
  usage.logUsage(db, {
    userId, feature, provider: settings.provider, model,
    inputTokens:  raw.inputTokens  || estimate.inputTokens,
    outputTokens: raw.outputTokens || estimate.outputTokens,
    costCents: realCost,
  });

  return { raw, cost_cents: realCost };
}

async function callWithRetryJson({ ctx, system, user, maxTokens, validate }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { raw, cost_cents } = await dispatchCall({ ...ctx, system, user, maxTokens, json: true });
    let obj;
    try {
      obj = typeof raw.content === 'object' ? raw.content : parseJsonStrict(raw.content);
      validate(obj);
      return { obj, cost_cents };
    } catch (e) {
      if (attempt === 1) {
        const err = new Error('Strukturierte Antwort konnte nicht validiert werden');
        err.httpStatus = 422;
        err.detail = { reason: e.message };
        throw err;
      }
      // retry once with a clarifying nudge
      user = user + '\n\n(Hinweis: Antworte ausschließlich mit reinem JSON, kein Markdown, kein Text drumherum.)';
    }
  }
}

module.exports = { PROVIDERS, pickProvider, assertActive, dispatchCall, callWithRetryJson };
