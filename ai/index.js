'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const cryptoMod = require('./crypto');
const cost      = require('./cost');
const usage     = require('./usage');

// ── Provider registry ────────────────────────────────────────
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

// ── Settings helpers ─────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

const DEFAULT_FEATURES = {
  brief: true, capture: true, result_draft: true, reentry: true,
  theme_tagging: false, digest: false, cross_meeting: false, drift: false,
};

function loadSettings(db, userId) {
  const row = db.prepare('SELECT * FROM ai_settings WHERE user_id=?').get(userId);
  if (!row) return null;
  let features;
  try { features = { ...DEFAULT_FEATURES, ...JSON.parse(row.features_enabled || '{}') }; }
  catch { features = { ...DEFAULT_FEATURES }; }
  return { ...row, features_enabled: features };
}

function saveSettings(db, userId, patch, encryptionKey) {
  const now = new Date().toISOString();
  let row = db.prepare('SELECT * FROM ai_settings WHERE user_id=?').get(userId);
  if (!row) {
    const id = uid();
    db.prepare(
      `INSERT INTO ai_settings(id,user_id,created_at,updated_at,features_enabled) VALUES (?,?,?,?,?)`
    ).run(id, userId, now, now, JSON.stringify(DEFAULT_FEATURES));
    row = db.prepare('SELECT * FROM ai_settings WHERE user_id=?').get(userId);
  }

  const updates = [];
  const params  = [];

  function set(col, val) { updates.push(`${col}=?`); params.push(val); }

  if (patch.provider != null)               set('provider', String(patch.provider));
  if (patch.model != null)                   set('model', String(patch.model));
  if (patch.azure_endpoint != null)          set('azure_endpoint', String(patch.azure_endpoint));
  if (patch.azure_api_version != null)       set('azure_api_version', String(patch.azure_api_version));
  if (patch.max_monthly_cost_cents != null)  set('max_monthly_cost_cents', patch.max_monthly_cost_cents | 0);
  if (patch.confirm_threshold_cents != null) set('confirm_threshold_cents', patch.confirm_threshold_cents | 0);
  if (patch.globally_disabled != null)       set('globally_disabled', patch.globally_disabled ? 1 : 0);
  if (patch.features_enabled != null) {
    const merged = { ...DEFAULT_FEATURES, ...patch.features_enabled };
    set('features_enabled', JSON.stringify(merged));
  }
  if (patch.api_key != null) {
    if (patch.api_key === '') {
      set('api_key_encrypted', '');
      set('api_key_last4', '');
    } else {
      set('api_key_encrypted', cryptoMod.encryptKey(patch.api_key, encryptionKey));
      set('api_key_last4', cryptoMod.last4(patch.api_key));
    }
  }
  if (updates.length) {
    updates.push('updated_at=?'); params.push(now);
    params.push(userId);
    db.prepare(`UPDATE ai_settings SET ${updates.join(',')} WHERE user_id=?`).run(...params);
  }
  return loadSettings(db, userId);
}

function clearApiKey(db, userId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE ai_settings SET api_key_encrypted=\'\', api_key_last4=\'\', updated_at=? WHERE user_id=?').run(now, userId);
  return loadSettings(db, userId);
}

function publicSettings(s) {
  if (!s) {
    return {
      provider: '', model: '', api_key_last4: '',
      azure_endpoint: '', azure_api_version: '',
      features_enabled: { ...DEFAULT_FEATURES },
      max_monthly_cost_cents: 0, confirm_threshold_cents: 10,
      globally_disabled: false,
      configured: false,
    };
  }
  return {
    provider: s.provider || '',
    model:    s.model    || '',
    api_key_last4:     s.api_key_last4 || '',
    azure_endpoint:    s.azure_endpoint || '',
    azure_api_version: s.azure_api_version || '',
    features_enabled:  s.features_enabled,
    max_monthly_cost_cents:  s.max_monthly_cost_cents  | 0,
    confirm_threshold_cents: s.confirm_threshold_cents | 0,
    globally_disabled: !!s.globally_disabled,
    configured: !!(s.provider && s.api_key_last4),
  };
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

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

// ── Prompt loading & interpolation ───────────────────────────
const PROMPT_DIR = path.join(__dirname, 'prompts');
const promptCache = {};

function loadPrompt(name) {
  if (promptCache[name]) return promptCache[name];
  const raw = fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), 'utf8');
  const sysMatch  = raw.match(/^#\s*SYSTEM\s*\n([\s\S]*?)(?=^#\s*USER\s*$)/m);
  const userMatch = raw.match(/^#\s*USER\s*\n([\s\S]*)$/m);
  const parsed = {
    system: (sysMatch  ? sysMatch[1]  : '').trim(),
    user:   (userMatch ? userMatch[1] : '').trim(),
  };
  promptCache[name] = parsed;
  return parsed;
}

function interpolate(tpl, vars) {
  // Supports {{key}} and {{#key}}…{{/key}} conditional blocks.
  let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, body) =>
    vars[k] ? body : ''
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  return out;
}

// ── JSON validation (lightweight, no extra dep) ──────────────
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

// ── Feature: Pre-Meeting Briefing (W-AI01) ───────────────────
async function briefMeeting({ db, userId, settings, encryptionKey, meetingId, confirmed }) {
  assertActive(settings, 'brief');
  const meeting = db.prepare('SELECT * FROM meetings WHERE id=? AND user_id=?').get(meetingId, userId);
  if (!meeting) throw httpErr(404, 'Meeting nicht gefunden');

  const topics = db.prepare('SELECT * FROM topics WHERE meeting_id=? ORDER BY sort_order, created_at').all(meetingId);
  const openTopics  = topics.filter(t => !t.done && !t.snoozed_until);
  const snoozedSoon = topics.filter(t => {
    if (!t.snoozed_until) return false;
    const wake = new Date(t.snoozed_until);
    const limit = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    return wake <= limit;
  });
  const recentResults = topics.filter(t => t.done && t.result).slice(-5);

  // Linked topics: same group_id in OTHER meetings
  const linkedTopics = [];
  for (const t of openTopics) {
    if (!t.group_id) continue;
    const others = db.prepare(
      'SELECT t.title AS title, m.title AS meeting FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.group_id=? AND t.meeting_id!=?'
    ).all(t.group_id, meetingId);
    others.forEach(o => linkedTopics.push(`${o.meeting}: ${o.title}`));
  }

  const tpl = loadPrompt('brief');
  const userText = interpolate(tpl.user, {
    meetingTitle: meeting.title,
    nextDate:     meeting.next_date || '—',
    participants: (() => { try { return JSON.parse(meeting.participants).join(', ') || '—'; } catch { return '—'; } })(),
    openTopics:   openTopics.length ? openTopics.map(t => `- ${t.title}${t.description ? ' — ' + stripHtml(t.description).slice(0, 200) : ''}`).join('\n') : '— keine —',
    snoozedSoon:  snoozedSoon.length ? snoozedSoon.map(t => `- ${t.title} (wacht auf am ${t.snoozed_until})`).join('\n') : '— keine —',
    recentResults: recentResults.length ? recentResults.map(t => `- ${t.title}: ${stripHtml(t.result).slice(0, 200)}`).join('\n') : '— keine —',
    linkedTopics: linkedTopics.length ? linkedTopics.map(s => `- ${s}`).join('\n') : '— keine —',
  });

  const ctx = { db, userId, settings, encryptionKey, feature: 'brief', confirmed };
  const { obj, cost_cents } = await callWithRetryJson({
    ctx, system: tpl.system, user: userText,
    maxTokens: cost.FEATURE_MAX_OUTPUT_TOKENS.brief,
    validate: validateBrief,
  });

  const artifactId = uid();
  db.prepare(
    'INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(artifactId, userId, 'meeting', meetingId, 'brief', JSON.stringify(obj), settings.model, new Date().toISOString());

  return { artifact_id: artifactId, content: obj, cost_cents };
}

// ── Feature: Post-Meeting Capture (W-AI02) ───────────────────
async function captureMeeting({ db, userId, settings, encryptionKey, meetingId, notes, confirmed }) {
  assertActive(settings, 'capture');
  if (!notes || !String(notes).trim()) throw httpErr(400, 'Notizen erforderlich');
  const meeting = db.prepare('SELECT * FROM meetings WHERE id=? AND user_id=?').get(meetingId, userId);
  if (!meeting) throw httpErr(404, 'Meeting nicht gefunden');

  const topics = db.prepare('SELECT id, title FROM topics WHERE meeting_id=? AND done=0').all(meetingId);
  const themes = db.prepare('SELECT id, title FROM themes WHERE user_id=?').all(userId);

  const tpl = loadPrompt('capture');
  const userText = interpolate(tpl.user, {
    meetingTitle:       meeting.title,
    existingTopicsList: topics.length ? topics.map(t => `${t.id} → ${t.title}`).join('\n') : '— keine —',
    availableThemes:    themes.length ? themes.map(t => `${t.id} → ${t.title}`).join('\n') : '— keine —',
    notes:              String(notes).slice(0, 50_000),
  });

  const ctx = { db, userId, settings, encryptionKey, feature: 'capture', confirmed };
  const { obj, cost_cents } = await callWithRetryJson({
    ctx, system: tpl.system, user: userText,
    maxTokens: cost.FEATURE_MAX_OUTPUT_TOKENS.capture,
    validate: validateCapture,
  });

  return { suggestions: obj, cost_cents };
}

// ── Feature: Result Draft (W-AI05) ───────────────────────────
async function draftResult({ db, userId, settings, encryptionKey, refType, refId, confirmed }) {
  assertActive(settings, 'result_draft');
  let title, description;
  if (refType === 'topic') {
    const t = db.prepare(
      'SELECT t.* FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=? AND m.user_id=?'
    ).get(refId, userId);
    if (!t) throw httpErr(404, 'Thema nicht gefunden');
    title = t.title; description = t.description;
  } else if (refType === 'todo') {
    const t = db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(refId, userId);
    if (!t) throw httpErr(404, 'Todo nicht gefunden');
    title = t.title; description = t.description;
  } else {
    throw httpErr(400, 'Ungültiger refType');
  }

  const tpl = loadPrompt('result-draft');
  const userText = interpolate(tpl.user, {
    title, description: stripHtml(description || '').slice(0, 4000),
    context: '',
  });

  const ctx = { db, userId, settings, encryptionKey, feature: 'result_draft', confirmed };
  const { raw, cost_cents } = await dispatchCall({
    ...ctx, system: tpl.system, user: userText,
    maxTokens: cost.FEATURE_MAX_OUTPUT_TOKENS.result_draft, json: false,
  });

  const draft = String(raw.content || '').trim();
  return { draft, cost_cents };
}

// ── Feature: Re-Entry Briefing (W-AI03, Phase 2) ─────────────
async function summarizeReentry({ db, userId, settings, encryptionKey, frameId, confirmed }) {
  assertActive(settings, 'reentry');

  const f = db.prepare('SELECT * FROM stack_frames WHERE id=? AND user_id=?').get(frameId, userId);
  if (!f) throw httpErr(404, 'Frame nicht gefunden');

  // Resolve referenced topic/todo for context
  let title = '(gelöscht)', description = '', lastResult = '';
  if (f.ref_type === 'topic') {
    const t = db.prepare('SELECT title, description, result FROM topics WHERE id=?').get(f.ref_id);
    if (t) { title = t.title; description = t.description || ''; lastResult = t.result || ''; }
  } else if (f.ref_type === 'todo') {
    const t = db.prepare('SELECT title, description, result FROM todos WHERE id=? AND user_id=?').get(f.ref_id, userId);
    if (t) { title = t.title; description = t.description || ''; lastResult = t.result || ''; }
  }

  const tpl = loadPrompt('reentry');
  const userText = interpolate(tpl.user, {
    title,
    nextStepNote: f.next_step_note,
    description:  stripHtml(description).slice(0, 2000),
    lastResult:   stripHtml(lastResult).slice(0, 2000) || '—',
  });

  const ctx = { db, userId, settings, encryptionKey, feature: 'reentry', confirmed };
  const { raw, cost_cents } = await dispatchCall({
    ...ctx, system: tpl.system, user: userText,
    maxTokens: cost.FEATURE_MAX_OUTPUT_TOKENS.reentry, json: false,
  });

  const summary = String(raw.content || '').trim();
  const artifactId = uid();
  db.prepare(
    'INSERT INTO ai_artifacts(id,user_id,ref_type,ref_id,feature,content,model,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(artifactId, userId, 'frame', frameId, 'reentry', JSON.stringify({ summary }), settings.model, new Date().toISOString());

  return { artifact_id: artifactId, content: { summary }, cost_cents };
}

// ── Apply capture suggestions (after user confirmation) ──────
function applyCapture(db, userId, meetingId, apply) {
  if (!db.prepare('SELECT 1 FROM meetings WHERE id=? AND user_id=?').get(meetingId, userId)) {
    throw httpErr(404, 'Meeting nicht gefunden');
  }
  const created = { topics: [], todos: [], theme_links: [], results: 0 };

  // New topics → topics in this meeting
  if (Array.isArray(apply.new_topics)) {
    for (const t of apply.new_topics) {
      if (!t || !t.title) continue;
      const id = uid();
      const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS m FROM topics WHERE meeting_id=?').get(meetingId).m;
      db.prepare(
        `INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,created_at,sort_order) VALUES (?,?,?,?,0,'','',?,?)`
      ).run(id, meetingId, String(t.title).slice(0, 300), String(t.description || ''), new Date().toISOString(), mx + 1);
      created.topics.push(id);
    }
  }
  // Results on existing topics
  if (Array.isArray(apply.topic_results)) {
    const upd = db.prepare(
      `UPDATE topics SET done=1, result=?, result_date=? WHERE id=? AND meeting_id=?`
    );
    const today = new Date().toISOString().slice(0, 10);
    for (const r of apply.topic_results) {
      if (!r || !r.topic_id || r.result == null) continue;
      const res = upd.run(String(r.result), today, r.topic_id, meetingId);
      if (res.changes) created.results++;
    }
  }
  // New todos
  if (Array.isArray(apply.new_todos)) {
    for (const t of apply.new_todos) {
      if (!t || !t.title) continue;
      const id = uid();
      const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS m FROM todos WHERE user_id=?').get(userId).m;
      db.prepare(
        `INSERT INTO todos(id,user_id,title,description,sort_order,created_at) VALUES (?,?,?,?,?,?)`
      ).run(id, userId, String(t.title).slice(0, 300), String(t.description || ''), mx + 1, new Date().toISOString());
      created.todos.push(id);
    }
  }
  // Theme links — only those with real ids; skip array-index placeholders
  if (Array.isArray(apply.theme_links)) {
    for (const l of apply.theme_links) {
      if (!l || !l.theme_id || !l.ref_type || !l.ref_id) continue;
      if (l.ref_id.startsWith('new_topics[') || l.ref_id.startsWith('new_todos[')) continue;
      // Validate ownership of theme
      const th = db.prepare('SELECT id FROM themes WHERE id=? AND user_id=?').get(l.theme_id, userId);
      if (!th) continue;
      try {
        const id = uid();
        db.prepare(
          'INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)'
        ).run(id, l.theme_id, l.ref_type, l.ref_id, new Date().toISOString());
        created.theme_links.push(id);
      } catch (_) { /* duplicate is fine */ }
    }
  }
  return created;
}

// ── Connection test ──────────────────────────────────────────
async function testConnection({ settings, encryptionKey }) {
  if (!settings)                   throw httpErr(409, 'AI nicht konfiguriert');
  if (settings.globally_disabled)  throw httpErr(409, 'AI ist deaktiviert');
  if (!settings.provider)          throw httpErr(409, 'kein Provider konfiguriert');
  if (!settings.api_key_encrypted) throw httpErr(409, 'kein API-Key konfiguriert');
  const provider = pickProvider(settings.provider);
  const isMock = process.env.AI_PROVIDER_OVERRIDE === 'mock' || settings.provider === 'mock';
  const apiKey = isMock ? 'mock' : cryptoMod.decryptKey(settings.api_key_encrypted, encryptionKey);
  try {
    return await provider.testConnection({
      apiKey, model: settings.model,
      azureEndpoint: settings.azure_endpoint,
      azureApiVersion: settings.azure_api_version,
    });
  } catch (e) {
    if (!e.httpStatus) e.httpStatus = 503;
    throw e;
  }
}

// ── CLI test hook (npm run ai:test) ──────────────────────────
async function testFromCli() {
  console.log('ai:test — not implemented as standalone yet. Use the /api/ai/test endpoint from the UI.');
}

// ── Utilities ────────────────────────────────────────────────
function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  // settings
  loadSettings, saveSettings, clearApiKey, publicSettings, DEFAULT_FEATURES,
  // features
  briefMeeting, captureMeeting, draftResult, summarizeReentry, applyCapture, testConnection,
  // usage re-exports
  usageSummary: (db, uid, period) => usage.usageSummary(db, uid, period),
  // CLI
  testFromCli,
  // internals exposed for tests
  _internals: { interpolate, parseJsonStrict, validateBrief, validateCapture, dispatchCall, callWithRetryJson },
};
