'use strict';
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE     = (process.env.BASE_PATH || '/notes').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'app.db');
const SEC_FILE = path.join(DATA_DIR, '.session-secret');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Session secret — generated once, persisted so restarts don't invalidate sessions
let sessionSecret;
if (fs.existsSync(SEC_FILE)) {
  sessionSecret = fs.readFileSync(SEC_FILE, 'utf8').trim();
} else {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SEC_FILE, sessionSecret, { mode: 0o600 });
}

// ── Database ────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'user',
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    participants       TEXT NOT NULL DEFAULT '[]',
    is_recurring       INTEGER NOT NULL DEFAULT 0,
    recurrence_pattern TEXT NOT NULL DEFAULT '',
    next_date          TEXT NOT NULL DEFAULT '',
    color              TEXT NOT NULL DEFAULT '#4f46e5',
    created_at         TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS topics (
    id          TEXT PRIMARY KEY,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    done        INTEGER NOT NULL DEFAULT 0,
    result      TEXT NOT NULL DEFAULT '',
    result_date TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS todos (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    done        INTEGER NOT NULL DEFAULT 0,
    result      TEXT NOT NULL DEFAULT '',
    result_date TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS themes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS theme_links (
    id         TEXT PRIMARY KEY,
    theme_id   TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
    ref_type   TEXT NOT NULL,
    ref_id     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(theme_id, ref_id)
  );
`);

// Migration: add sort_order to meetings if missing
{
  const cols = db.prepare('PRAGMA table_info(meetings)').all();
  if (!cols.find(c => c.name === 'sort_order')) {
    db.exec('ALTER TABLE meetings ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    const users = db.prepare('SELECT id FROM users').all();
    db.transaction(() => {
      for (const u of users) {
        const ms = db.prepare('SELECT id FROM meetings WHERE user_id=? ORDER BY next_date,created_at').all(u.id);
        ms.forEach((m, i) => db.prepare('UPDATE meetings SET sort_order=? WHERE id=?').run(i, m.id));
      }
    })();
  }
}

// Migration: add result/result_date to todos if missing
{
  const cols = db.prepare('PRAGMA table_info(todos)').all();
  if (!cols.find(c => c.name === 'result')) {
    db.exec("ALTER TABLE todos ADD COLUMN result TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE todos ADD COLUMN result_date TEXT NOT NULL DEFAULT ''");
  }
}

// Migration: add group_id to topics if missing
{
  const cols = db.prepare('PRAGMA table_info(topics)').all();
  if (!cols.find(c => c.name === 'group_id')) {
    db.exec('ALTER TABLE topics ADD COLUMN group_id TEXT');
  }
}

// Migration: add is_todo to topics if missing
{
  const cols = db.prepare('PRAGMA table_info(topics)').all();
  if (!cols.find(c => c.name === 'is_todo')) {
    db.exec('ALTER TABLE topics ADD COLUMN is_todo INTEGER NOT NULL DEFAULT 0');
  }
}

// Migration: add snoozed_until to topics if missing
{
  const cols = db.prepare('PRAGMA table_info(topics)').all();
  if (!cols.find(c => c.name === 'snoozed_until')) {
    db.exec("ALTER TABLE topics ADD COLUMN snoozed_until TEXT NOT NULL DEFAULT ''");
  }
}

// Migration: add snoozed_until to todos if missing
{
  const cols = db.prepare('PRAGMA table_info(todos)').all();
  if (!cols.find(c => c.name === 'snoozed_until')) {
    db.exec("ALTER TABLE todos ADD COLUMN snoozed_until TEXT NOT NULL DEFAULT ''");
  }
}

// Migration: add sort_order column if missing
{
  const cols = db.prepare('PRAGMA table_info(topics)').all();
  if (!cols.find(c => c.name === 'sort_order')) {
    db.exec('ALTER TABLE topics ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    const allMeetings = db.prepare('SELECT id FROM meetings').all();
    const initOrder = db.transaction(() => {
      for (const m of allMeetings) {
        const ts = db.prepare('SELECT id FROM topics WHERE meeting_id=? ORDER BY created_at').all(m.id);
        ts.forEach((t, i) => db.prepare('UPDATE topics SET sort_order=? WHERE id=?').run(i, t.id));
      }
    });
    initOrder();
  }
}

// ── Migration: AI tables (Erweiterung v1.1, Phase 1) ─────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_settings (
    id                       TEXT PRIMARY KEY,
    user_id                  TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    provider                 TEXT NOT NULL DEFAULT '',
    model                    TEXT NOT NULL DEFAULT '',
    api_key_encrypted        TEXT NOT NULL DEFAULT '',
    api_key_last4            TEXT NOT NULL DEFAULT '',
    azure_endpoint           TEXT NOT NULL DEFAULT '',
    azure_api_version        TEXT NOT NULL DEFAULT '',
    features_enabled         TEXT NOT NULL DEFAULT '{}',
    max_monthly_cost_cents   INTEGER NOT NULL DEFAULT 0,
    confirm_threshold_cents  INTEGER NOT NULL DEFAULT 10,
    globally_disabled        INTEGER NOT NULL DEFAULT 0,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_usage (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature              TEXT NOT NULL,
    provider             TEXT NOT NULL,
    model                TEXT NOT NULL,
    input_tokens         INTEGER NOT NULL DEFAULT 0,
    output_tokens        INTEGER NOT NULL DEFAULT 0,
    cost_estimate_cents  INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time ON ai_usage(user_id, created_at);
  CREATE TABLE IF NOT EXISTS ai_artifacts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref_type    TEXT NOT NULL,
    ref_id      TEXT NOT NULL,
    feature     TEXT NOT NULL,
    content     TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_artifacts_ref ON ai_artifacts(ref_type, ref_id);
`);

// ── Migration: updated_at + AI settings extensions (v1.1, Phase 3) ──
(function migratePhase3() {
  function hasCol(table, name) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name);
  }
  if (!hasCol('topics', 'updated_at')) {
    db.exec(`ALTER TABLE topics ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE topics SET updated_at = created_at WHERE updated_at = ''`);
  }
  if (!hasCol('todos', 'updated_at')) {
    db.exec(`ALTER TABLE todos ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE todos SET updated_at = created_at WHERE updated_at = ''`);
  }
  const aiCols = db.prepare(`PRAGMA table_info(ai_settings)`).all().map(c => c.name);
  const add = (name, sql) => { if (!aiCols.includes(name)) db.exec(`ALTER TABLE ai_settings ADD COLUMN ${sql}`); };
  add('drift_days',            'drift_days INTEGER NOT NULL DEFAULT 21');
  add('theme_tag_threshold',   'theme_tag_threshold REAL NOT NULL DEFAULT 0.7');
  add('weekly_digest_enabled', 'weekly_digest_enabled INTEGER NOT NULL DEFAULT 0');
  add('weekly_digest_dow',     'weekly_digest_dow INTEGER NOT NULL DEFAULT 0');
  add('weekly_digest_hour',    'weekly_digest_hour INTEGER NOT NULL DEFAULT 18');
})();

// ── Migration: Stack-Layer (Erweiterung v1.1, Phase 2) ───────
db.exec(`
  CREATE TABLE IF NOT EXISTS stack_frames (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref_type        TEXT NOT NULL,
    ref_id          TEXT NOT NULL,
    next_step_note  TEXT NOT NULL,
    pushed_at       TEXT NOT NULL,
    popped_at       TEXT,
    parent_frame_id TEXT,
    pop_resolution  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_stack_user_open ON stack_frames(user_id, popped_at);
  CREATE INDEX IF NOT EXISTS idx_stack_ref       ON stack_frames(ref_type, ref_id);
`);

// ── Encryption key for AI provider secrets (analogous to session secret) ──
const ENC_FILE = path.join(DATA_DIR, '.encryption-key');
let encryptionKey;
if (fs.existsSync(ENC_FILE)) {
  encryptionKey = Buffer.from(fs.readFileSync(ENC_FILE, 'utf8').trim(), 'hex');
} else {
  encryptionKey = crypto.randomBytes(32);
  fs.writeFileSync(ENC_FILE, encryptionKey.toString('hex'), { mode: 0o600 });
}

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// Create default admin on first run with a random password
if (db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0) {
  const initPw = crypto.randomBytes(10).toString('base64url').slice(0, 12);
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(
    uid(), 'admin', bcrypt.hashSync(initPw, 12), 'admin', new Date().toISOString()
  );
  console.log('\n┌──────────────────────────────────────────────┐');
  console.log('│  Erster Start — Standard-Admin angelegt:     │');
  console.log(`│  Benutzername : admin                        │`);
  console.log(`│  Passwort     : ${initPw.padEnd(28)}│`);
  console.log('│  Bitte nach dem ersten Login ändern!         │');
  console.log('└──────────────────────────────────────────────┘\n');
}

// ── Security helpers ─────────────────────────────────────────
const loginAttempts = new Map();
function isLoginBlocked(ip) {
  const e = loginAttempts.get(ip);
  return e && Date.now() < e.until && e.count >= 10;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  let e = loginAttempts.get(ip);
  if (!e || now >= e.until) e = { count: 0, until: now + 15 * 60 * 1000 };
  e.count++;
  loginAttempts.set(ip, e);
}
function clearLoginAttempts(ip) { loginAttempts.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now >= v.until) loginAttempts.delete(k);
}, 10 * 60 * 1000);

function isValidHexColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c); }

const MAX_TITLE = 300;
const MAX_DESC  = 100_000;

function stripUnsafeHtml(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    .replace(/<iframe\b[\s\S]*?(?:<\/iframe\s*>|$)/gi, '')
    .replace(/\bon\w{1,30}\s*=/gi, 'data-x=')
    .replace(/(href|src|action)\s*=\s*["']?\s*(?:javascript|vbscript|data)\s*:/gi, '$1="#"');
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "script-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'");
  next();
});

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.HTTPS === 'true',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

const requireAuth = (req, res, next) => {
  if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.uid);
  if (u?.role !== 'admin') return res.status(403).json({ error: 'Keine Berechtigung' });
  next();
};

// ── Serialisation helpers ───────────────────────────────────
function parseMeeting(m, topics = []) {
  return {
    id: m.id, title: m.title, description: m.description, color: m.color,
    participants: JSON.parse(m.participants || '[]'),
    isRecurring: !!m.is_recurring, recurrencePattern: m.recurrence_pattern,
    nextDate: m.next_date, createdAt: m.created_at,
    topics: topics.filter(t => t.meeting_id === m.id).map(parseTopic),
  };
}
function parseTopic(t) {
  return {
    id: t.id, meetingId: t.meeting_id, title: t.title, description: t.description,
    done: !!t.done, result: t.result, resultDate: t.result_date, createdAt: t.created_at,
    sortOrder: t.sort_order, isTodo: !!t.is_todo, groupId: t.group_id ?? null,
    snoozedUntil: t.snoozed_until || null,
  };
}

const A = BASE + '/api';

// ── Auth routes ──────────────────────────────────────────────
app.post(`${A}/login`, (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (isLoginBlocked(ip))
    return res.status(429).json({ error: 'Zu viele Fehlversuche — bitte 15 Minuten warten.' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }
  clearLoginAttempts(ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Sitzungsfehler' });
    req.session.uid = u.id;
    res.json({ id: u.id, username: u.username, role: u.role });
  });
});

app.post(`${A}/logout`, (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get(`${A}/me`, requireAuth, (req, res) => {
  const u = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(req.session.uid);
  if (!u) { req.session.destroy(); return res.status(401).json({ error: 'Nicht angemeldet' }); }
  res.json(u);
});

app.put(`${A}/password`, requireAuth, (req, res) => {
  const { current, next: newPw } = req.body || {};
  if (!current || !newPw) return res.status(400).json({ error: 'Eingaben fehlen' });
  if (newPw.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.uid);
  if (!bcrypt.compareSync(current, u.password_hash))
    return res.status(400).json({ error: 'Aktuelles Passwort falsch' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPw, 10), req.session.uid);
  res.json({ ok: true });
});

// ── Meeting routes ───────────────────────────────────────────
app.get(`${A}/meetings`, requireAuth, (req, res) => {
  const ms = db.prepare('SELECT * FROM meetings WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.uid);
  const ts = ms.length
    ? db.prepare(`SELECT * FROM topics WHERE meeting_id IN (${ms.map(()=>'?').join(',')}) ORDER BY sort_order, created_at`).all(...ms.map(m=>m.id))
    : [];
  res.json(ms.map(m => parseMeeting(m, ts)));
});

app.post(`${A}/meetings`, requireAuth, (req, res) => {
  const { title, description='', participants=[], isRecurring=false, recurrencePattern='', nextDate='', color='#4f46e5' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (title.length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (!isValidHexColor(color)) return res.status(400).json({ error: 'Ungültige Farbe' });
  const id = uid();
  const mxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM meetings WHERE user_id=?').get(req.session.uid).m;
  db.prepare('INSERT INTO meetings(id,user_id,title,description,participants,is_recurring,recurrence_pattern,next_date,color,created_at,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    id, req.session.uid, title.trim(), description, JSON.stringify(participants),
    isRecurring?1:0, recurrencePattern, nextDate, color, new Date().toISOString(), mxOrder + 1
  );
  res.status(201).json(parseMeeting(db.prepare('SELECT * FROM meetings WHERE id=?').get(id)));
});

app.put(`${A}/meetings/reorder`, requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids erforderlich' });
  const update = db.prepare('UPDATE meetings SET sort_order=? WHERE id=? AND user_id=?');
  db.transaction(() => ids.forEach((id, i) => update.run(i, id, req.session.uid)))();
  res.json({ ok: true });
});

app.put(`${A}/meetings/:id`, requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!m) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title=m.title, description=m.description, participants, isRecurring, recurrencePattern, nextDate, color=m.color } = req.body;
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (!isValidHexColor(color)) return res.status(400).json({ error: 'Ungültige Farbe' });
  db.prepare('UPDATE meetings SET title=?,description=?,participants=?,is_recurring=?,recurrence_pattern=?,next_date=?,color=? WHERE id=?').run(
    title, description,
    JSON.stringify(participants ?? JSON.parse(m.participants)),
    isRecurring !== undefined ? (isRecurring?1:0) : m.is_recurring,
    recurrencePattern ?? m.recurrence_pattern,
    nextDate ?? m.next_date,
    color, m.id
  );
  res.json({ ok: true });
});

app.delete(`${A}/meetings/:id`, requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM meetings WHERE id=? AND user_id=?').run(req.params.id, req.session.uid);
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Nicht gefunden' });
});

// ── Topic routes ─────────────────────────────────────────────
function ownsMeeting(uid, mid) {
  return !!db.prepare('SELECT 1 FROM meetings WHERE id=? AND user_id=?').get(mid, uid);
}

app.post(`${A}/meetings/:id/topics`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title, description='' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  const id = uid();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM topics WHERE meeting_id=?').get(req.params.id).m;
  db.prepare(`INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,created_at,sort_order) VALUES (?,?,?,?,0,'','',?,?)`)
    .run(id, req.params.id, title.trim(), description, new Date().toISOString(), maxOrder + 1);
  res.status(201).json(parseTopic(db.prepare('SELECT * FROM topics WHERE id=?').get(id)));
});

app.put(`${A}/meetings/:id/topics/reorder`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids erforderlich' });
  const update = db.prepare('UPDATE topics SET sort_order=? WHERE id=? AND meeting_id=?');
  db.transaction(() => ids.forEach((id, i) => update.run(i, id, req.params.id)))();
  res.json({ ok: true });
});

app.post(`${A}/meetings/:id/topics/:tid/share`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const t = db.prepare('SELECT * FROM topics WHERE id=? AND meeting_id=?').get(req.params.tid, req.params.id);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { targetMeetingId } = req.body || {};
  if (!targetMeetingId) return res.status(400).json({ error: 'targetMeetingId erforderlich' });
  if (!ownsMeeting(req.session.uid, targetMeetingId)) return res.status(404).json({ error: 'Ziel-Meeting nicht gefunden' });
  if (targetMeetingId === req.params.id) return res.status(400).json({ error: 'Quelle und Ziel sind identisch' });

  let groupId = t.group_id;
  if (!groupId) {
    groupId = crypto.randomUUID ? crypto.randomUUID() : uid();
    db.prepare('UPDATE topics SET group_id=? WHERE id=?').run(groupId, t.id);
  }

  const existing = db.prepare('SELECT id FROM topics WHERE group_id=? AND meeting_id=?').get(groupId, targetMeetingId);
  if (existing) return res.status(409).json({ error: 'Thema ist bereits in diesem Meeting vorhanden' });

  const newId = uid();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM topics WHERE meeting_id=?').get(targetMeetingId).m;
  db.prepare(`INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,created_at,sort_order,group_id) VALUES (?,?,?,?,0,'','',?,?,?)`)
    .run(newId, targetMeetingId, t.title, t.description, new Date().toISOString(), maxOrder + 1, groupId);
  res.status(201).json(parseTopic(db.prepare('SELECT * FROM topics WHERE id=?').get(newId)));
});

// Move topic → other meeting  OR  topic → personal todos
app.post(`${A}/meetings/:id/topics/:tid/move`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const t = db.prepare('SELECT * FROM topics WHERE id=? AND meeting_id=?').get(req.params.tid, req.params.id);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { targetMeetingId } = req.body || {};

  if (targetMeetingId) {
    // ── Move to another meeting ────────────────────────────────
    if (targetMeetingId === req.params.id) return res.status(400).json({ error: 'Quelle und Ziel sind identisch' });
    if (!ownsMeeting(req.session.uid, targetMeetingId)) return res.status(404).json({ error: 'Ziel-Meeting nicht gefunden' });
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM topics WHERE meeting_id=?').get(targetMeetingId).m;
    // Dissolve any shared-group linkage first (the topic leaves its origin meeting)
    if (t.group_id) {
      const remaining = db.prepare('SELECT id FROM topics WHERE group_id=? AND id!=?').all(t.group_id, t.id);
      if (remaining.length === 1) db.prepare('UPDATE topics SET group_id=NULL WHERE id=?').run(remaining[0].id);
    }
    db.prepare('UPDATE topics SET meeting_id=?, sort_order=?, group_id=NULL WHERE id=?').run(targetMeetingId, maxOrder + 1, t.id);
    res.json({ ok: true, targetType: 'meeting', targetId: targetMeetingId });
  } else {
    // ── Convert to personal todo ───────────────────────────────
    const id = uid();
    const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM todos WHERE user_id=?').get(req.session.uid).m;
    db.prepare('INSERT INTO todos(id,user_id,title,description,done,result,result_date,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, req.session.uid, t.title, t.description, t.done, t.result, t.result_date, mx + 1, new Date().toISOString());
    // Transfer theme_links to the new todo
    db.prepare('UPDATE theme_links SET ref_type=?, ref_id=? WHERE ref_type=? AND ref_id=?').run('todo', id, 'topic', t.id);
    // Dissolve group if needed
    if (t.group_id) {
      const remaining = db.prepare('SELECT id FROM topics WHERE group_id=? AND id!=?').all(t.group_id, t.id);
      if (remaining.length === 1) db.prepare('UPDATE topics SET group_id=NULL WHERE id=?').run(remaining[0].id);
    }
    db.prepare('DELETE FROM topics WHERE id=?').run(t.id);
    res.json({ ok: true, targetType: 'todo', newId: id });
  }
});

// Move personal todo → meeting
app.post(`${A}/todos/:id/move`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { targetMeetingId } = req.body || {};
  if (!targetMeetingId) return res.status(400).json({ error: 'targetMeetingId erforderlich' });
  if (!ownsMeeting(req.session.uid, targetMeetingId)) return res.status(404).json({ error: 'Meeting nicht gefunden' });
  const id = uid();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM topics WHERE meeting_id=?').get(targetMeetingId).m;
  db.prepare('INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, targetMeetingId, t.title, t.description, t.done, t.result, t.result_date, maxOrder + 1, new Date().toISOString());
  // Transfer theme_links to the new topic
  db.prepare('UPDATE theme_links SET ref_type=?, ref_id=? WHERE ref_type=? AND ref_id=?').run('topic', id, 'todo', t.id);
  db.prepare('DELETE FROM todos WHERE id=?').run(t.id);
  res.json({ ok: true, targetMeetingId, newId: id });
});

app.put(`${A}/meetings/:id/topics/:tid`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const t = db.prepare('SELECT * FROM topics WHERE id=? AND meeting_id=?').get(req.params.tid, req.params.id);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title=t.title, description=t.description, done, result, resultDate, isTodo, snoozedUntil } = req.body;
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  const cleanDesc = stripUnsafeHtml(description);
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE topics SET title=?,description=?,done=?,result=?,result_date=?,is_todo=?,snoozed_until=?,updated_at=? WHERE id=?').run(
    title, cleanDesc,
    done !== undefined ? (done?1:0) : t.done,
    result ?? t.result,
    resultDate ?? t.result_date,
    isTodo !== undefined ? (isTodo?1:0) : t.is_todo,
    snoozedUntil !== undefined ? (snoozedUntil || '') : t.snoozed_until,
    nowIso,
    t.id
  );
  // Propagate title+description changes to all group members
  if (t.group_id) {
    db.prepare('UPDATE topics SET title=?, description=?, updated_at=? WHERE group_id=? AND id!=?')
      .run(title, cleanDesc, nowIso, t.group_id, t.id);
  }
  res.json({ ok: true });
});

app.delete(`${A}/meetings/:id/topics/:tid`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const t = db.prepare('SELECT * FROM topics WHERE id=? AND meeting_id=?').get(req.params.tid, req.params.id);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  db.prepare('DELETE FROM theme_links WHERE ref_type=? AND ref_id=?').run('topic', t.id);
  db.prepare('DELETE FROM topics WHERE id=?').run(t.id);
  // If only one group member remains, dissolve the group
  if (t.group_id) {
    const remaining = db.prepare('SELECT id FROM topics WHERE group_id=?').all(t.group_id);
    if (remaining.length === 1) {
      db.prepare('UPDATE topics SET group_id=NULL WHERE id=?').run(remaining[0].id);
    }
  }
  res.json({ ok: true });
});

// ── Todo routes ──────────────────────────────────────────────
function parseTodo(t) {
  return { id: t.id, title: t.title, description: t.description,
           done: !!t.done, result: t.result, resultDate: t.result_date,
           snoozedUntil: t.snoozed_until || null,
           sortOrder: t.sort_order, createdAt: t.created_at };
}

app.get(`${A}/todos`, requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM todos WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.uid).map(parseTodo));
});

app.post(`${A}/todos`, requireAuth, (req, res) => {
  const { title, description='' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  const id = uid();
  const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM todos WHERE user_id=?').get(req.session.uid).m;
  db.prepare('INSERT INTO todos(id,user_id,title,description,sort_order,created_at) VALUES (?,?,?,?,?,?)').run(id, req.session.uid, title.trim(), description, mx+1, new Date().toISOString());
  res.status(201).json(parseTodo(db.prepare('SELECT * FROM todos WHERE id=?').get(id)));
});

app.put(`${A}/todos/reorder`, requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids erforderlich' });
  const upd = db.prepare('UPDATE todos SET sort_order=? WHERE id=? AND user_id=?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id, req.session.uid)))();
  res.json({ ok: true });
});

app.put(`${A}/todos/:id`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title=t.title, description=t.description, done, result, resultDate, snoozedUntil } = req.body;
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  db.prepare('UPDATE todos SET title=?,description=?,done=?,result=?,result_date=?,snoozed_until=?,updated_at=? WHERE id=?').run(
    title, stripUnsafeHtml(description), done !== undefined ? (done?1:0) : t.done,
    stripUnsafeHtml(result ?? t.result), resultDate ?? t.result_date,
    snoozedUntil !== undefined ? (snoozedUntil || '') : t.snoozed_until,
    new Date().toISOString(),
    t.id);
  res.json({ ok: true });
});

app.delete(`${A}/todos/:id`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT id FROM todos WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  db.prepare('DELETE FROM theme_links WHERE ref_type=? AND ref_id=?').run('todo', t.id);
  db.prepare('DELETE FROM todos WHERE id=?').run(t.id);
  res.json({ ok: true });
});

// ── Theme routes ─────────────────────────────────────────────
function parseTheme(t, links = []) {
  return {
    id: t.id, title: t.title, description: t.description,
    sortOrder: t.sort_order, createdAt: t.created_at,
    links: links.filter(l => l.theme_id === t.id).map(l => ({
      id: l.id, refType: l.ref_type, refId: l.ref_id,
    })),
  };
}

app.get(`${A}/themes`, requireAuth, (req, res) => {
  const ts = db.prepare('SELECT * FROM themes WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.uid);
  const links = ts.length
    ? db.prepare(`SELECT * FROM theme_links WHERE theme_id IN (${ts.map(()=>'?').join(',')})`)
        .all(...ts.map(t => t.id))
    : [];
  res.json(ts.map(t => parseTheme(t, links)));
});

app.post(`${A}/themes`, requireAuth, (req, res) => {
  const { title, description='' } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  const id = uid();
  const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM themes WHERE user_id=?').get(req.session.uid).m;
  db.prepare('INSERT INTO themes(id,user_id,title,description,sort_order,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, req.session.uid, title.trim(), stripUnsafeHtml(description), mx + 1, new Date().toISOString());
  res.status(201).json(parseTheme(db.prepare('SELECT * FROM themes WHERE id=?').get(id)));
});

app.put(`${A}/themes/reorder`, requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids erforderlich' });
  const upd = db.prepare('UPDATE themes SET sort_order=? WHERE id=? AND user_id=?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id, req.session.uid)))();
  res.json({ ok: true });
});

app.put(`${A}/themes/:id`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title=t.title, description=t.description } = req.body || {};
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  db.prepare('UPDATE themes SET title=?,description=? WHERE id=?').run(title, stripUnsafeHtml(description), t.id);
  res.json({ ok: true });
});

app.delete(`${A}/themes/:id`, requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM themes WHERE id=? AND user_id=?').run(req.params.id, req.session.uid);
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Nicht gefunden' });
});

app.post(`${A}/themes/:id/links`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { refType, refId } = req.body || {};
  if (!['topic','todo'].includes(refType) || !refId) return res.status(400).json({ error: 'Ungültige Verknüpfung' });
  try {
    const id = uid();
    db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)')
      .run(id, t.id, refType, refId, new Date().toISOString());
    res.status(201).json({ id, themeId: t.id, refType, refId });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Bereits verknüpft' });
    throw e;
  }
});

app.delete(`${A}/themes/:id/links/:lid`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT id FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  db.prepare('DELETE FROM theme_links WHERE id=? AND theme_id=?').run(req.params.lid, t.id);
  res.json({ ok: true });
});

// ── User routes (admin only) ─────────────────────────────────
app.get(`${A}/users`, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,username,role,created_at FROM users ORDER BY created_at').all());
});

app.post(`${A}/users`, requireAdmin, (req, res) => {
  const { username, password, role='user' } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  if (username.trim().length > 80) return res.status(400).json({ error: 'Benutzername zu lang' });
  if (password.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
  try {
    const id = uid();
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(
      id, username.trim(), bcrypt.hashSync(password,10), role==='admin'?'admin':'user', new Date().toISOString()
    );
    res.status(201).json({ id, username: username.trim(), role: role==='admin'?'admin':'user' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
    throw e;
  }
});

app.put(`${A}/users/:id`, requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  const { password, role } = req.body || {};
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password,10), req.params.id);
  }
  if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role==='admin'?'admin':'user', req.params.id);
  res.json({ ok: true });
});

app.delete(`${A}/users/:id`, requireAdmin, (req, res) => {
  if (req.params.id === req.session.uid)
    return res.status(400).json({ error: 'Sie können sich nicht selbst löschen' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── AI routes (Erweiterung v1.1, Phase 1) ────────────────────
const ai = require('./ai');

function aiErr(res, e) {
  const status = e.httpStatus || 500;
  const body   = { error: e.message || 'AI-Fehler' };
  if (e.code)   body.code   = e.code;
  if (e.detail) body.detail = e.detail;
  res.status(status).json(body);
}

// Settings
app.get(`${A}/ai/settings`, requireAuth, (req, res) => {
  const s = ai.loadSettings(db, req.session.uid);
  res.json(ai.publicSettings(s));
});

app.put(`${A}/ai/settings`, requireAuth, (req, res) => {
  try {
    const s = ai.saveSettings(db, req.session.uid, req.body || {}, encryptionKey);
    res.json(ai.publicSettings(s));
  } catch (e) { aiErr(res, e); }
});

app.delete(`${A}/ai/settings/key`, requireAuth, (req, res) => {
  const s = ai.clearApiKey(db, req.session.uid);
  res.json(ai.publicSettings(s));
});

app.get(`${A}/ai/usage`, requireAuth, (req, res) => {
  const period = req.query.period === 'today' || req.query.period === 'week' ? req.query.period : 'month';
  res.json(ai.usageSummary(db, req.session.uid, period));
});

app.post(`${A}/ai/test`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.testConnection({ settings: s, encryptionKey });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});

// Features
app.post(`${A}/ai/meeting/:id/brief`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.briefMeeting({
      db, userId: req.session.uid, settings: s, encryptionKey,
      meetingId: req.params.id,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});

app.post(`${A}/ai/meeting/:id/capture`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const body = req.body || {};
    if (body.apply_now) {
      const created = ai.applyCapture(db, req.session.uid, req.params.id, body.apply_now);
      return res.json({ created });
    }
    const r = await ai.captureMeeting({
      db, userId: req.session.uid, settings: s, encryptionKey,
      meetingId: req.params.id,
      notes: body.notes,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});

app.post(`${A}/ai/topic/:id/result-draft`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.draftResult({
      db, userId: req.session.uid, settings: s, encryptionKey,
      refType: 'topic', refId: req.params.id,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});

app.post(`${A}/ai/todo/:id/result-draft`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.draftResult({
      db, userId: req.session.uid, settings: s, encryptionKey,
      refType: 'todo', refId: req.params.id,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});

app.post(`${A}/ai/stack/:frameId/reentry`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.summarizeReentry({
      db, userId: req.session.uid, settings: s, encryptionKey,
      frameId: req.params.frameId,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});

// ── Phase 3: Auto-Theme-Tagging (W-AI04) ─────────────────────
app.post(`${A}/ai/topic/:id/suggest-themes`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.suggestThemes({
      db, userId: req.session.uid, settings: s, encryptionKey,
      refType: 'topic', refId: req.params.id,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});
app.post(`${A}/ai/todo/:id/suggest-themes`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.suggestThemes({
      db, userId: req.session.uid, settings: s, encryptionKey,
      refType: 'todo', refId: req.params.id,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});

// ── Phase 3: Weekly Digest (W-AI06) ──────────────────────────
app.get(`${A}/ai/digest/weekly`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.weeklyDigest({
      db, userId: req.session.uid, settings: s, encryptionKey,
      confirmed: req.query.confirm === 'true',
      force: false,
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});
app.post(`${A}/ai/digest/weekly`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.weeklyDigest({
      db, userId: req.session.uid, settings: s, encryptionKey,
      confirmed: req.query.confirm === 'true',
      force: true,
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});
app.get(`${A}/ai/digest/archive`, requireAuth, (req, res) => {
  res.json({ entries: ai.listDigestArchive(db, req.session.uid) });
});

// ── Phase 3: Cross-Meeting-Insight (W-AI07) ──────────────────
app.get(`${A}/ai/insights/cross-meeting/:meetingId`, requireAuth, (req, res) => {
  const c = ai.loadCrossMeeting(db, req.session.uid, req.params.meetingId);
  res.json(c || { artifact_id: null, content: { matches: [] } });
});
app.post(`${A}/ai/insights/cross-meeting/:meetingId`, requireAuth, async (req, res) => {
  try {
    const s = ai.loadSettings(db, req.session.uid);
    const r = await ai.crossMeetingInsight({
      db, userId: req.session.uid, settings: s, encryptionKey,
      meetingId: req.params.meetingId,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
});
app.delete(`${A}/ai/insights/cross-meeting/:meetingId/:artifactId`, requireAuth, (req, res) => {
  const ok = ai.deleteCrossMeeting(db, req.session.uid, req.params.artifactId);
  if (!ok) return res.status(404).json({ error: 'Artefakt nicht gefunden' });
  res.json({ ok: true });
});

// ── Phase 3: Drift-Detection (W-AI08) ────────────────────────
app.get(`${A}/ai/insights/drift`, requireAuth, (req, res) => {
  const s = ai.loadSettings(db, req.session.uid);
  const driftDays = (s && s.drift_days) || 21;
  res.json({ drifted: ai.driftDetection(db, req.session.uid, driftDays), drift_days: driftDays });
});

// ── Stack-Layer routes (Erweiterung v1.1, Phase 2) ───────────
const MAX_NOTE = 1000;
const VALID_RESOLUTIONS = new Set(['done', 'snoozed', 'dropped', 'resumed']);

function ownsRef(uid, refType, refId) {
  if (refType === 'topic') {
    return !!db.prepare(
      'SELECT 1 FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=? AND m.user_id=?'
    ).get(refId, uid);
  }
  if (refType === 'todo') {
    return !!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=?').get(refId, uid);
  }
  return false;
}

function refTitleAndDescription(refType, refId) {
  if (refType === 'topic') {
    const t = db.prepare('SELECT title, description, result FROM topics WHERE id=?').get(refId);
    return t ? { title: t.title, description: t.description, result: t.result, exists: true }
             : { title: '(gelöscht)', description: '', result: '', exists: false };
  }
  if (refType === 'todo') {
    const t = db.prepare('SELECT title, description, result FROM todos WHERE id=?').get(refId);
    return t ? { title: t.title, description: t.description, result: t.result, exists: true }
             : { title: '(gelöscht)', description: '', result: '', exists: false };
  }
  return { title: '(unbekannt)', description: '', result: '', exists: false };
}

function frameToJson(f) {
  const ref = refTitleAndDescription(f.ref_type, f.ref_id);
  return {
    id: f.id,
    ref_type: f.ref_type,
    ref_id: f.ref_id,
    title: ref.title,
    ref_exists: ref.exists,
    next_step_note: f.next_step_note,
    pushed_at: f.pushed_at,
    popped_at: f.popped_at || null,
    parent_frame_id: f.parent_frame_id || null,
    pop_resolution: f.pop_resolution || null,
    age_seconds: Math.max(0, Math.floor((Date.now() - new Date(f.pushed_at).getTime()) / 1000)),
  };
}

// Sort open frames so the current "active" frame is first. We chase the
// parent_frame_id chain backwards: the frame referenced by no other open
// frame is the active one (it has no child).
function orderActiveFirst(openFrames) {
  if (openFrames.length === 0) return [];
  const byId   = new Map(openFrames.map(f => [f.id, f]));
  const isParent = new Set(openFrames.map(f => f.parent_frame_id).filter(Boolean));
  // Active = the one nobody points to as parent
  let active = openFrames.find(f => !isParent.has(f.id));
  // Defensive fallback: newest pushed_at wins
  if (!active) active = [...openFrames].sort((a, b) => b.pushed_at.localeCompare(a.pushed_at))[0];
  const out = [active];
  let cur = active;
  while (cur && cur.parent_frame_id && byId.has(cur.parent_frame_id)) {
    cur = byId.get(cur.parent_frame_id);
    out.push(cur);
  }
  // Append any leftover frames (shouldn't happen with consistent state)
  for (const f of openFrames) if (!out.includes(f)) out.push(f);
  return out;
}

app.get(`${A}/stack`, requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM stack_frames WHERE user_id=? AND popped_at IS NULL'
  ).all(req.session.uid);
  const ordered = orderActiveFirst(rows);
  res.json({ frames: ordered.map(frameToJson), depth: ordered.length });
});

app.post(`${A}/stack/push`, requireAuth, (req, res) => {
  const { refType, refId, nextStepNote } = req.body || {};
  if (!refType || !refId)                  return res.status(400).json({ error: 'refType und refId erforderlich' });
  if (!['topic','todo'].includes(refType)) return res.status(400).json({ error: 'Ungültiger refType' });
  const note = String(nextStepNote || '').trim();
  if (!note)                  return res.status(400).json({ error: 'next_step_note erforderlich' });
  if (note.length > MAX_NOTE) return res.status(400).json({ error: 'next_step_note zu lang (max 1000)' });

  if (!ownsRef(req.session.uid, refType, refId)) return res.status(404).json({ error: 'Referenz nicht gefunden' });

  const dup = db.prepare(
    'SELECT id FROM stack_frames WHERE user_id=? AND ref_type=? AND ref_id=? AND popped_at IS NULL'
  ).get(req.session.uid, refType, refId);
  if (dup) return res.status(409).json({ error: 'Referenz ist bereits in einem offenen Frame', code: 'conflict_existing', frame_id: dup.id });

  // Current top = parent of the new frame
  const open = db.prepare(
    'SELECT * FROM stack_frames WHERE user_id=? AND popped_at IS NULL'
  ).all(req.session.uid);
  const ordered = orderActiveFirst(open);
  const parentId = ordered[0]?.id || null;

  const id = uid();
  db.prepare(
    'INSERT INTO stack_frames(id,user_id,ref_type,ref_id,next_step_note,pushed_at,parent_frame_id) VALUES (?,?,?,?,?,?,?)'
  ).run(id, req.session.uid, refType, refId, note, new Date().toISOString(), parentId);

  const frame = db.prepare('SELECT * FROM stack_frames WHERE id=?').get(id);
  const newDepth = ordered.length + 1;
  res.status(201).json({
    frame: frameToJson(frame),
    depth: newDepth,
    depth_warning: newDepth >= 4,
  });
});

app.post(`${A}/stack/pop/:frameId`, requireAuth, (req, res) => {
  const { resolution, result, resultDate, snoozedUntil } = req.body || {};
  if (!VALID_RESOLUTIONS.has(resolution)) return res.status(400).json({ error: 'Ungültige resolution' });

  const f = db.prepare(
    'SELECT * FROM stack_frames WHERE id=? AND user_id=? AND popped_at IS NULL'
  ).get(req.params.frameId, req.session.uid);
  if (!f) return res.status(404).json({ error: 'Frame nicht gefunden oder bereits geschlossen' });

  const now = new Date().toISOString();
  const applied = {};

  if (resolution === 'resumed') {
    // Frame stays open; just make it the active top by rewiring parent chain.
    const openOthers = db.prepare(
      'SELECT * FROM stack_frames WHERE user_id=? AND popped_at IS NULL AND id != ?'
    ).all(req.session.uid, f.id);
    const ordered = orderActiveFirst(openOthers);
    const newParent = ordered[0]?.id || null;
    if (newParent !== f.parent_frame_id) {
      db.prepare('UPDATE stack_frames SET parent_frame_id=? WHERE id=?').run(newParent, f.id);
    }
    const updated = db.prepare('SELECT * FROM stack_frames WHERE id=?').get(f.id);
    return res.json({
      frame: frameToJson(updated),
      next_active: frameToJson(updated),
      applied,
      drift_warning: false,
    });
  }

  // Apply side effects on referenced topic/todo
  if (resolution === 'done') {
    const date = resultDate || new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();
    if (f.ref_type === 'topic') {
      const upd = db.prepare('UPDATE topics SET done=1, result=COALESCE(?, result), result_date=COALESCE(?, result_date), updated_at=? WHERE id=?')
        .run(result != null ? stripUnsafeHtml(String(result)) : null,
             result != null ? date : null,
             nowIso,
             f.ref_id);
      applied.topicDone = upd.changes === 1;
      if (result != null) applied.resultSaved = true;
    } else if (f.ref_type === 'todo') {
      const upd = db.prepare('UPDATE todos SET done=1, result=COALESCE(?, result), result_date=COALESCE(?, result_date), updated_at=? WHERE id=? AND user_id=?')
        .run(result != null ? stripUnsafeHtml(String(result)) : null,
             result != null ? date : null,
             nowIso,
             f.ref_id, req.session.uid);
      applied.todoDone = upd.changes === 1;
      if (result != null) applied.resultSaved = true;
    }
  } else if (resolution === 'snoozed') {
    const until = snoozedUntil || defaultSnoozeUntilTomorrow();
    if (f.ref_type === 'topic') {
      const upd = db.prepare('UPDATE topics SET snoozed_until=? WHERE id=?').run(until, f.ref_id);
      if (upd.changes === 1) applied.snoozedUntil = until;
    } else if (f.ref_type === 'todo') {
      const upd = db.prepare('UPDATE todos SET snoozed_until=? WHERE id=? AND user_id=?').run(until, f.ref_id, req.session.uid);
      if (upd.changes === 1) applied.snoozedUntil = until;
    }
  }
  // 'dropped': no side effect.

  // Close the frame
  db.prepare('UPDATE stack_frames SET popped_at=?, pop_resolution=? WHERE id=?').run(now, resolution, f.id);

  // Determine new active frame
  const openAfter = db.prepare(
    'SELECT * FROM stack_frames WHERE user_id=? AND popped_at IS NULL'
  ).all(req.session.uid);
  const ordered = orderActiveFirst(openAfter);
  const nextActive = ordered[0] ? frameToJson(ordered[0]) : null;

  // Drift detection (W-S09)
  const ageSec = (new Date(now).getTime() - new Date(f.pushed_at).getTime()) / 1000;
  const drift = ageSec < 30 && resolution !== 'done';

  const updated = db.prepare('SELECT * FROM stack_frames WHERE id=?').get(f.id);
  res.json({
    frame: frameToJson(updated),
    next_active: nextActive,
    applied,
    drift_warning: drift,
  });
});

app.get(`${A}/stack/peek/:frameId`, requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM stack_frames WHERE id=? AND user_id=?').get(req.params.frameId, req.session.uid);
  if (!f) return res.status(404).json({ error: 'Frame nicht gefunden' });
  res.json({ frame: frameToJson(f) });
});

app.get(`${A}/stack/history`, requireAuth, (req, res) => {
  const where = ['user_id=?', 'popped_at IS NOT NULL'];
  const params = [req.session.uid];
  if (req.query.from)       { where.push('popped_at >= ?'); params.push(String(req.query.from)); }
  if (req.query.to)         { where.push('popped_at <= ?'); params.push(String(req.query.to) + 'T23:59:59'); }
  if (req.query.resolution) { where.push('pop_resolution = ?'); params.push(String(req.query.resolution)); }
  const rows = db.prepare(
    `SELECT * FROM stack_frames WHERE ${where.join(' AND ')} ORDER BY popped_at DESC LIMIT 500`
  ).all(...params);
  res.json({ frames: rows.map(frameToJson), count: rows.length });
});

app.put(`${A}/stack/:frameId/note`, requireAuth, (req, res) => {
  const note = String(req.body?.nextStepNote || '').trim();
  if (!note)                  return res.status(400).json({ error: 'next_step_note erforderlich' });
  if (note.length > MAX_NOTE) return res.status(400).json({ error: 'next_step_note zu lang (max 1000)' });
  const r = db.prepare(
    'UPDATE stack_frames SET next_step_note=? WHERE id=? AND user_id=? AND popped_at IS NULL'
  ).run(note, req.params.frameId, req.session.uid);
  if (!r.changes) return res.status(404).json({ error: 'Frame nicht gefunden oder bereits geschlossen' });
  res.json({ ok: true });
});

function defaultSnoozeUntilTomorrow() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

// ── Frontend ─────────────────────────────────────────────────
app.get(BASE || '/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
if (BASE) app.get('/', (req, res) => res.redirect(BASE));

module.exports = { app, db };

if (require.main === module) {
  // Phase 3: schlanker Wochen-Digest-Scheduler (kein eigener Worker)
  try {
    const aiJobs = require('./ai/jobs');
    aiJobs.start({ db, encryptionKey });
  } catch (e) {
    console.error('[ai/jobs] start failed:', e.message || e);
  }
}

if (require.main === module) app.listen(PORT, () => {
  console.log(`✓ Server läuft auf Port ${PORT}`);
  console.log(`✓ Erreichbar unter: http://localhost:${PORT}${BASE || '/'}`);
});
