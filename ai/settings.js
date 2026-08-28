'use strict';
const crypto = require('crypto');
const cryptoMod = require('./crypto');
// SSRF-Absicherung für den nutzerdefinierten Azure-Endpoint (Security Review,
// Mittel, A10): dieselbe Blockliste/URL-Validierung wie beim Link-Fetch-
// Feature wiederverwenden statt einer zweiten Prüfung (Wiederverwendungsgebot).
const { assertUrlAllowed, SafeFetchError } = require('../lib/safe-fetch');
const { httpErr } = require('./errors');

// ── Settings helpers ─────────────────────────────────────────
// Aus ai/index.js extrahiert (Arbeit zur Lesbarkeit/Wartbarkeit) - Verhalten
// unveraendert. `uid` bleibt exportiert, da ai/index.js es auch fuer
// Artefakt-/Entity-IDs jenseits von ai_settings verwendet.
function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

const DEFAULT_FEATURES = {
  brief: true, capture: true, result_draft: true, reentry: true,
  theme_tagging: false, digest: false, cross_meeting: false, drift: false,
  link_summary: false,
  // S2: ereignisgetriebene KI-Zusammenfassungen (Fortschritt/Beschreibung).
  // Default AUS wie alle anderen kostenrelevanten Features.
  progress_summary: false, description_summary: false,
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
  if (patch.azure_endpoint != null) {
    const endpoint = String(patch.azure_endpoint);
    if (endpoint !== '') {
      // Literale IP-Ziele (Loopback/Link-Local/Metadaten-Dienste/RFC1918 etc.)
      // ablehnen; Hostname-basiertes DNS-Rebinding wird beim eigentlichen
      // Request nicht zusätzlich geprüft (kein Lookup-Hook für den Azure-SDK-
      // Client) - siehe Abschlussbericht.
      try { assertUrlAllowed(endpoint); }
      catch (e) {
        if (e instanceof SafeFetchError) throw httpErr(400, 'Ungültiger oder nicht erlaubter Azure-Endpoint.');
        throw e;
      }
    }
    set('azure_endpoint', endpoint);
  }
  if (patch.azure_api_version != null)       set('azure_api_version', String(patch.azure_api_version));
  if (patch.max_monthly_cost_cents != null)  set('max_monthly_cost_cents', patch.max_monthly_cost_cents | 0);
  if (patch.confirm_threshold_cents != null) set('confirm_threshold_cents', patch.confirm_threshold_cents | 0);
  if (patch.globally_disabled != null)       set('globally_disabled', patch.globally_disabled ? 1 : 0);
  if (patch.drift_days != null)              set('drift_days', Math.max(1, patch.drift_days | 0));
  if (patch.theme_tag_threshold != null)     set('theme_tag_threshold', Math.max(0, Math.min(1, Number(patch.theme_tag_threshold))));
  if (patch.weekly_digest_enabled != null)   set('weekly_digest_enabled', patch.weekly_digest_enabled ? 1 : 0);
  if (patch.weekly_digest_dow != null)       set('weekly_digest_dow', Math.max(0, Math.min(6, patch.weekly_digest_dow | 0)));
  if (patch.weekly_digest_hour != null)      set('weekly_digest_hour', Math.max(0, Math.min(23, patch.weekly_digest_hour | 0)));
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
      drift_days: 21,
      theme_tag_threshold: 0.7,
      weekly_digest_enabled: false,
      weekly_digest_dow: 0,
      weekly_digest_hour: 18,
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
    drift_days:            (s.drift_days != null) ? (s.drift_days | 0) : 21,
    theme_tag_threshold:   (s.theme_tag_threshold != null) ? Number(s.theme_tag_threshold) : 0.7,
    weekly_digest_enabled: !!s.weekly_digest_enabled,
    weekly_digest_dow:     (s.weekly_digest_dow != null) ? (s.weekly_digest_dow | 0) : 0,
    weekly_digest_hour:    (s.weekly_digest_hour != null) ? (s.weekly_digest_hour | 0) : 18,
    configured: !!(s.provider && s.api_key_last4),
  };
}

module.exports = { uid, DEFAULT_FEATURES, loadSettings, saveSettings, clearApiKey, publicSettings };
