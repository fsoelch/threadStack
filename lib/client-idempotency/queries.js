'use strict';
// Query- und Validierungsschicht fuer idempotente Neuanlage (Arbeitspaket P1).
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CAPTURED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const DAY_MS = 86400000;
const MAX_PAST_MS = 365 * DAY_MS;

// null/undefined/"" = fehlend. Alles andere muss ein String sein, der die Regex erfuellt.
function parseClientToken(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, token: null };
  if (typeof raw !== 'string' || !CLIENT_TOKEN_RE.test(raw)) return { ok: false };
  return { ok: true, token: raw };
}

function parseCapturedAt(raw, { now = new Date() } = {}) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, iso: null };
  if (typeof raw !== 'string' || raw.length > 40 || !CAPTURED_AT_RE.test(raw)) return { ok: false };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { ok: false };
  const nowMs = now.getTime();
  let t = ms;
  if (t > nowMs + MAX_FUTURE_MS || t < nowMs - MAX_PAST_MS) t = nowMs;
  return { ok: true, iso: new Date(t).toISOString() };
}

function lookupClientToken(db, userId, token) {
  const row = db.prepare('SELECT ref_type, ref_id FROM client_create_tokens WHERE user_id=? AND client_token=?')
    .get(userId, token);
  return row ? { refType: row.ref_type, refId: row.ref_id } : null;
}

// Wirft bei PK-Konflikt (bewusst kein INSERT OR IGNORE).
function recordClientToken(db, { userId, token, refType, refId, nowIso }) {
  db.prepare('INSERT INTO client_create_tokens(user_id,client_token,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
    .run(userId, token, refType, refId, nowIso);
}

module.exports = { DAY_MS, CLIENT_TOKEN_RE, parseClientToken, parseCapturedAt, lookupClientToken, recordClientToken };
