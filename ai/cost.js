'use strict';

// Coarse token estimation. Anthropic/OpenAI docs cite chars/4 as a reasonable
// approximation; German runs slightly denser but the deviation is acceptable
// for a budget/confirmation heuristic.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// Default output-token budgets per feature (from plan, F2).
const FEATURE_MAX_OUTPUT_TOKENS = {
  brief:         2000,
  capture:       3000,
  reentry:        400,
  result_draft:   800,
  theme_tagging:  500,
  digest:        1500,
  cross_meeting:  800,
  drift:          800,
  test:             1,
};

// Cost per 1M tokens, in cents (USD ≈ EUR for budget purposes; conservative).
// If a model isn't found, we fall back to DEFAULT to ensure budget gating works.
const PRICE_TABLE = {
  // Anthropic — current generation
  'claude-sonnet-4-5':   { input: 300,  output: 1500 },
  'claude-sonnet-4-6':   { input: 300,  output: 1500 },
  'claude-opus-4-5':     { input: 1500, output: 7500 },
  'claude-opus-4-7':     { input: 1500, output: 7500 },
  'claude-haiku-4-5':    { input:  80,  output:  400 },
  // OpenAI
  'gpt-5':               { input: 250,  output: 1000 },
  'gpt-5-mini':          { input:  50,  output:  200 },
  'gpt-4o':              { input: 250,  output: 1000 },
  'gpt-4o-mini':         { input:  15,  output:   60 },
  // Conservative fallback
  DEFAULT:               { input: 500,  output: 2000 },
};

function lookupPrice(model) {
  return PRICE_TABLE[model] || PRICE_TABLE.DEFAULT;
}

function estimateCostCents({ model, inputTokens, outputTokens }) {
  const p = lookupPrice(model);
  const inCents  = (inputTokens  * p.input)  / 1_000_000;
  const outCents = (outputTokens * p.output) / 1_000_000;
  // Round up to whole cents to avoid losing fractions in budget tracking.
  return Math.ceil(inCents + outCents);
}

function estimateBeforeCall({ model, feature, promptText }) {
  const inputTokens  = estimateTokens(promptText);
  const outputTokens = FEATURE_MAX_OUTPUT_TOKENS[feature] || 1000;
  return {
    inputTokens,
    outputTokens,
    cost_cents: estimateCostCents({ model, inputTokens, outputTokens }),
  };
}

module.exports = {
  estimateTokens,
  estimateCostCents,
  estimateBeforeCall,
  lookupPrice,
  FEATURE_MAX_OUTPUT_TOKENS,
  PRICE_TABLE,
};
