'use strict';
const crypto = require('crypto');

// All persistence is injected via the db handle from server.js to avoid
// duplicate connections. Same pattern as the rest of the AI module.

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function startOfMonthIso(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
function startOfWeekIso(d = new Date()) {
  const day = (d.getUTCDay() + 6) % 7; // Monday=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString();
}
function startOfDayIso(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function logUsage(db, { userId, feature, provider, model, inputTokens, outputTokens, costCents }) {
  db.prepare(
    'INSERT INTO ai_usage(id,user_id,feature,provider,model,input_tokens,output_tokens,cost_estimate_cents,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    uid(), userId, feature, provider, model,
    inputTokens|0, outputTokens|0, costCents|0,
    new Date().toISOString()
  );
}

function monthlySpendCents(db, userId) {
  const since = startOfMonthIso();
  const row = db.prepare(
    'SELECT COALESCE(SUM(cost_estimate_cents),0) AS s FROM ai_usage WHERE user_id=? AND created_at >= ?'
  ).get(userId, since);
  return row.s | 0;
}

// Throws an object with httpStatus when budget would be exceeded.
function assertBudgetOk(db, userId, settings, estimatedCents) {
  const limit = settings.max_monthly_cost_cents | 0;
  if (limit <= 0) return; // unlimited
  const spent = monthlySpendCents(db, userId);
  if (spent + estimatedCents > limit) {
    const err = new Error('Monatliches AI-Budget erschöpft');
    err.httpStatus = 402;
    err.code = 'budget_exceeded';
    err.detail = { spent_cents: spent, limit_cents: limit, estimated_cents: estimatedCents };
    throw err;
  }
}

// Throws 428 unless `confirmed` is truthy and estimate exceeds the threshold.
function assertConfirmedIfExpensive(settings, estimatedCents, confirmed) {
  const threshold = settings.confirm_threshold_cents | 0;
  if (threshold <= 0) return;
  if (estimatedCents < threshold) return;
  if (confirmed) return;
  const err = new Error('Bestätigung erforderlich');
  err.httpStatus = 428;
  err.code = 'confirmation_required';
  err.detail = { estimated_cost_cents: estimatedCents, threshold_cents: threshold };
  throw err;
}

function usageSummary(db, userId, period /* 'today' | 'week' | 'month' */) {
  let since;
  if (period === 'today') since = startOfDayIso();
  else if (period === 'week') since = startOfWeekIso();
  else since = startOfMonthIso();
  const rows = db.prepare(
    `SELECT feature,
            SUM(cost_estimate_cents) AS cost_cents,
            SUM(input_tokens + output_tokens) AS tokens,
            COUNT(*) AS calls
     FROM ai_usage
     WHERE user_id=? AND created_at >= ?
     GROUP BY feature`
  ).all(userId, since);
  const total = rows.reduce((s, r) => s + (r.cost_cents | 0), 0);
  return {
    period,
    since,
    total_cost_cents: total,
    entries: rows.map(r => ({
      feature: r.feature,
      cost_cents: r.cost_cents | 0,
      tokens: r.tokens | 0,
      calls: r.calls | 0,
    })),
  };
}

module.exports = {
  logUsage,
  monthlySpendCents,
  assertBudgetOk,
  assertConfirmedIfExpensive,
  usageSummary,
};
