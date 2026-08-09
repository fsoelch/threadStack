'use strict';
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { sanitizeKnowledgeHtml, htmlToText, MAX_KNOWLEDGE_CONTENT } = require('./lib/sanitize');
const { knowledgeThemeIds, knowledgeRelatedIds } = require('./lib/knowledge-queries');
const { safeFetchPage, SafeFetchError } = require('./lib/safe-fetch');
const { extractReadableText, ExtractError } = require('./lib/html-extract');
const linkCache = require('./ai/link-cache');
const aiUsage = require('./ai/usage');

const app      = express();
// If behind a trusted reverse proxy (e.g. nginx on same host), set TRUST_PROXY=1
// so req.ip reflects the real client IP for rate-limiting.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
const PORT     = process.env.PORT || 3000;
const BASE     = (process.env.BASE_PATH || '/notes').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'app.db');
const SEC_FILE = path.join(DATA_DIR, '.session-secret');

fs.mkdirSync(DATA_DIR, { recursive: true });

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

// Migration: add due_date to todos if missing
{
  const cols = db.prepare('PRAGMA table_info(todos)').all();
  if (!cols.find(c => c.name === 'due_date')) {
    db.exec("ALTER TABLE todos ADD COLUMN due_date TEXT NOT NULL DEFAULT ''");
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
  if (!hasCol('todos', 'is_private')) {
    db.exec(`ALTER TABLE todos ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0`);
  }
  const aiCols = db.prepare(`PRAGMA table_info(ai_settings)`).all().map(c => c.name);
  const add = (name, sql) => { if (!aiCols.includes(name)) db.exec(`ALTER TABLE ai_settings ADD COLUMN ${sql}`); };
  add('drift_days',            'drift_days INTEGER NOT NULL DEFAULT 21');
  add('theme_tag_threshold',   'theme_tag_threshold REAL NOT NULL DEFAULT 0.7');
  add('weekly_digest_enabled', 'weekly_digest_enabled INTEGER NOT NULL DEFAULT 0');
  add('weekly_digest_dow',     'weekly_digest_dow INTEGER NOT NULL DEFAULT 0');
  add('weekly_digest_hour',    'weekly_digest_hour INTEGER NOT NULL DEFAULT 18');
})();

// ── Attachments ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref_type   TEXT NOT NULL,
    ref_id     TEXT NOT NULL,
    filename   TEXT NOT NULL,
    stored_as  TEXT NOT NULL,
    mime_type  TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_ref ON attachments(ref_type, ref_id);
`);

// ── Migration: last_active_at für Users ──────────────────────
{
  const cols = db.prepare('PRAGMA table_info(users)').all();
  if (!cols.find(c => c.name === 'last_active_at')) {
    db.exec("ALTER TABLE users ADD COLUMN last_active_at TEXT NOT NULL DEFAULT ''");
  }
}

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

// ── Migration: Contacts (Ansprechpartner) ────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, sort_order, created_at);
`);

// ── Migration: Topic-Hierarchie (Wissensmanagement v2) ───────
{
  const cols = db.prepare('PRAGMA table_info(themes)').all();
  if (!cols.find(c => c.name === 'parent_id')) {
    db.exec('ALTER TABLE themes ADD COLUMN parent_id TEXT REFERENCES themes(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_themes_parent ON themes(parent_id)');
  }
}

// ── Migration: Wissensseiten (Wissensmanagement v2) ──────────
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_pages (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_pages_user ON knowledge_pages(user_id);
  CREATE TABLE IF NOT EXISTS knowledge_topic_links (
    id                 TEXT PRIMARY KEY,
    knowledge_page_id  TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
    theme_id           TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
    created_at         TEXT NOT NULL,
    UNIQUE(knowledge_page_id, theme_id)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_links_page  ON knowledge_topic_links(knowledge_page_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_links_theme ON knowledge_topic_links(theme_id);
`);

// ── Migration: FTS5-Volltextindex (Wissensmanagement v2, Phase 4) ──
// Ersetzt die frühere client-seitige LIKE-Suche durch einen echten Volltextindex
// mit Relevanz-Ranking (bm25), der auch Wissensseiten mit abdeckt.
{
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='search_index'"
  ).get();
  if (!ftsExists) {
    db.transaction(() => {
      db.exec(`
        CREATE VIRTUAL TABLE search_index USING fts5(
          ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body
        );
      `);
      db.exec(`
        INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
          SELECT 'meeting', id, user_id, title, description FROM meetings;
        INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
          SELECT 'theme', id, user_id, title, description FROM themes;
        INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
          SELECT 'topic', t.id, m.user_id, t.title, t.description || ' ' || t.result
          FROM topics t JOIN meetings m ON m.id = t.meeting_id;
        INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
          SELECT 'todo', id, user_id, title, description || ' ' || result FROM todos;
        INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
          SELECT 'contact', id, user_id, name,
            COALESCE(role,'') || ' ' || COALESCE(email,'') || ' ' || COALESCE(description,'') FROM contacts;
        INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
          SELECT 'knowledge', id, user_id, title, content FROM knowledge_pages;
      `);
      db.exec(`
        CREATE TRIGGER trg_search_meetings_ai AFTER INSERT ON meetings BEGIN
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('meeting', new.id, new.user_id, new.title, new.description);
        END;
        CREATE TRIGGER trg_search_meetings_au AFTER UPDATE ON meetings BEGIN
          DELETE FROM search_index WHERE ref_type='meeting' AND ref_id=old.id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('meeting', new.id, new.user_id, new.title, new.description);
        END;
        CREATE TRIGGER trg_search_meetings_ad AFTER DELETE ON meetings BEGIN
          DELETE FROM search_index WHERE ref_type='meeting' AND ref_id=old.id;
        END;

        CREATE TRIGGER trg_search_themes_ai AFTER INSERT ON themes BEGIN
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('theme', new.id, new.user_id, new.title, new.description);
        END;
        CREATE TRIGGER trg_search_themes_au AFTER UPDATE ON themes BEGIN
          DELETE FROM search_index WHERE ref_type='theme' AND ref_id=old.id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('theme', new.id, new.user_id, new.title, new.description);
        END;
        CREATE TRIGGER trg_search_themes_ad AFTER DELETE ON themes BEGIN
          DELETE FROM search_index WHERE ref_type='theme' AND ref_id=old.id;
        END;

        CREATE TRIGGER trg_search_topics_ai AFTER INSERT ON topics BEGIN
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'topic', new.id, m.user_id, new.title, new.description || ' ' || new.result FROM meetings m WHERE m.id = new.meeting_id;
        END;
        CREATE TRIGGER trg_search_topics_au AFTER UPDATE ON topics BEGIN
          DELETE FROM search_index WHERE ref_type='topic' AND ref_id=old.id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'topic', new.id, m.user_id, new.title, new.description || ' ' || new.result FROM meetings m WHERE m.id = new.meeting_id;
        END;
        CREATE TRIGGER trg_search_topics_ad AFTER DELETE ON topics BEGIN
          DELETE FROM search_index WHERE ref_type='topic' AND ref_id=old.id;
        END;

        CREATE TRIGGER trg_search_todos_ai AFTER INSERT ON todos BEGIN
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('todo', new.id, new.user_id, new.title, new.description || ' ' || new.result);
        END;
        CREATE TRIGGER trg_search_todos_au AFTER UPDATE ON todos BEGIN
          DELETE FROM search_index WHERE ref_type='todo' AND ref_id=old.id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('todo', new.id, new.user_id, new.title, new.description || ' ' || new.result);
        END;
        CREATE TRIGGER trg_search_todos_ad AFTER DELETE ON todos BEGIN
          DELETE FROM search_index WHERE ref_type='todo' AND ref_id=old.id;
        END;

        CREATE TRIGGER trg_search_contacts_ai AFTER INSERT ON contacts BEGIN
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
            COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
        END;
        CREATE TRIGGER trg_search_contacts_au AFTER UPDATE ON contacts BEGIN
          DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
            COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
        END;
        CREATE TRIGGER trg_search_contacts_ad AFTER DELETE ON contacts BEGIN
          DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
        END;

        CREATE TRIGGER trg_search_knowledge_ai AFTER INSERT ON knowledge_pages BEGIN
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content);
        END;
        CREATE TRIGGER trg_search_knowledge_au AFTER UPDATE ON knowledge_pages BEGIN
          DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content);
        END;
        CREATE TRIGGER trg_search_knowledge_ad AFTER DELETE ON knowledge_pages BEGIN
          DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
        END;
      `);
    })();
  }
}

// ── Migration: Wissensseiten-Verknüpfungen (Wissensmanagement v2.1, Block A) ──
// Ungerichtete Verknüpfung zwischen zwei Wissensseiten. Ungerichtetheit wird
// strukturell erzwungen: vor jedem Insert werden die beiden IDs lexikografisch
// sortiert (a < b), das CHECK verhindert Selbstverweise, UNIQUE liefert Idempotenz.
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_links (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id)            ON DELETE CASCADE,
    page_a_id  TEXT NOT NULL REFERENCES knowledge_pages(id)  ON DELETE CASCADE,
    page_b_id  TEXT NOT NULL REFERENCES knowledge_pages(id)  ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE(page_a_id, page_b_id),
    CHECK(page_a_id < page_b_id)
  );
  CREATE INDEX IF NOT EXISTS idx_klinks_a ON knowledge_links(page_a_id);
  CREATE INDEX IF NOT EXISTS idx_klinks_b ON knowledge_links(page_b_id);
`);

// ── Migration: Graph-Knoten-Positionen (Wissensmanagement v2.1, Paket 1b) ──
// Nur das Schema wird hier angelegt; Routen dafür gehören zu einem separaten
// Arbeitspaket (Graph-Modul).
db.exec(`
  CREATE TABLE IF NOT EXISTS graph_node_positions (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_type  TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, node_type, node_id)
  ) WITHOUT ROWID;
`);

// ── Migration: knowledge_pages.content_text + FTS-Neuaufbau (Wissensmanagement v2.1, Block A) ──
// content_text hält den auf reinen Text reduzierten Inhalt (via htmlToText) für
// FTS/Snippets; content bleibt das sanitized HTML für die Anzeige.
{
  const hasContentText = db.prepare('PRAGMA table_info(knowledge_pages)').all().some(c => c.name === 'content_text');
  if (!hasContentText) {
    db.transaction(() => {
      db.exec(`ALTER TABLE knowledge_pages ADD COLUMN content_text TEXT NOT NULL DEFAULT ''`);

      const pages = db.prepare('SELECT id, content FROM knowledge_pages').all();
      const updText = db.prepare('UPDATE knowledge_pages SET content_text=? WHERE id=?');
      for (const p of pages) updText.run(htmlToText(p.content || ''), p.id);

      // Drop + recreate the three FTS triggers so they index content_text instead of raw content.
      db.exec(`
        DROP TRIGGER IF EXISTS trg_search_knowledge_ai;
        DROP TRIGGER IF EXISTS trg_search_knowledge_au;
        DROP TRIGGER IF EXISTS trg_search_knowledge_ad;

        CREATE TRIGGER trg_search_knowledge_ai AFTER INSERT ON knowledge_pages BEGIN
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content_text);
        END;
        CREATE TRIGGER trg_search_knowledge_au AFTER UPDATE ON knowledge_pages BEGIN
          DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content_text);
        END;
        CREATE TRIGGER trg_search_knowledge_ad AFTER DELETE ON knowledge_pages BEGIN
          DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
        END;
      `);

      // Reindex all existing knowledge rows in search_index with the new body.
      db.exec(`DELETE FROM search_index WHERE ref_type='knowledge'`);
      const reindex = db.prepare(
        `INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', ?, ?, ?, ?)`
      );
      for (const p of db.prepare('SELECT id, user_id, title, content_text FROM knowledge_pages').all()) {
        reindex.run(p.id, p.user_id, p.title, p.content_text);
      }
    })();
  }
}

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

const BCRYPT_ROUNDS = 12;
// Dummy hash used during login for constant-time comparison when user is not found
const DUMMY_HASH = bcrypt.hashSync('__dummy_constant_time__', BCRYPT_ROUNDS);

// Create default admin on first run with a random password
if (db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0) {
  const initPw = crypto.randomBytes(10).toString('base64url').slice(0, 12);
  db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)').run(
    uid(), 'admin', bcrypt.hashSync(initPw, BCRYPT_ROUNDS), 'admin', new Date().toISOString(), ''
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
function isValidDate(s) {
  if (!s) return true;
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.Z+-]{1,30})?$/.exec(s);
  if (!m) return false;
  if (Number.isNaN(Date.parse(s))) return false;
  // Kalendertag-Plausibilität unabhängig von Uhrzeit/Zeitzone prüfen (z.B. 30. Februar
  // wird von Date.parse() sonst stillschweigend auf den 2. März "korrigiert").
  const [, y, mo, d] = m.map(Number);
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  return asUtc.getUTCFullYear() === y && asUtc.getUTCMonth() === mo - 1 && asUtc.getUTCDate() === d;
}

const MAX_TITLE = 300;
const MAX_DESC  = 500_000;

// ── Fehler-Envelope (verbindlich für Wissensmanagement-v2.1-Endpunkte, Block A) ──
// { error: 'Deutscher Klartext', code: 'UPPER_SNAKE_CASE', ...extra }
function fail(res, status, code, msg, extra) {
  res.status(status).json(Object.assign({ error: msg, code }, extra || {}));
}

function stripUnsafeHtml(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    .replace(/<iframe\b[\s\S]*?(?:<\/iframe\s*>|$)/gi, '')
    .replace(/<object\b[\s\S]*?(?:<\/object\s*>|$)/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<form\b[\s\S]*?(?:<\/form\s*>|$)/gi, '')
    .replace(/\bon\w{1,30}\s*=/gi, 'data-x=')
    .replace(/(href|src|action)\s*=\s*["']?\s*(?:javascript|vbscript|data)\s*:/gi, '$1="#"')
    .replace(/expression\s*\(/gi, '(');
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));

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
  rolling: true,                                // Sliding-Expiration: jedes Request erneuert den Cookie
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.HTTPS === 'true',
    maxAge: 12 * 60 * 60 * 1000,                // 12 hours of inactivity → auto-logout
  },
}));

// Schreibt last_active_at maximal alle 5 Minuten (verhindert DB-Write bei jedem Request)
const updateLastActive = (() => {
  const INTERVAL = 5 * 60 * 1000; // 5 min
  const cache    = new Map();       // uid → last write timestamp
  const stmt     = db.prepare('UPDATE users SET last_active_at=? WHERE id=?');
  return (uid) => {
    const now = Date.now();
    if (!cache.has(uid) || now - cache.get(uid) > INTERVAL) {
      stmt.run(new Date().toISOString(), uid);
      cache.set(uid, now);
    }
  };
})();

const requireAuth = (req, res, next) => {
  if (!req.session.uid) return res.status(401).json({ error: 'Nicht angemeldet' });
  updateLastActive(req.session.uid);
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
  // Always run bcrypt to prevent user-enumeration via timing difference
  const valid = bcrypt.compareSync(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !valid) {
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

// Simple per-user rate limit for password changes (max 5 per hour)
const pwChangeLimiter = new Map();
function isPwChangeBlocked(uid) {
  const e = pwChangeLimiter.get(uid);
  if (!e) return false;
  const cutoff = Date.now() - 60 * 60 * 1000;
  e.attempts = e.attempts.filter(t => t > cutoff);
  if (e.attempts.length === 0) { pwChangeLimiter.delete(uid); return false; }
  return e.attempts.length >= 5;
}
function recordPwChange(uid) {
  const e = pwChangeLimiter.get(uid) || { attempts: [] };
  e.attempts.push(Date.now());
  pwChangeLimiter.set(uid, e);
}

app.put(`${A}/password`, requireAuth, (req, res) => {
  if (isPwChangeBlocked(req.session.uid))
    return res.status(429).json({ error: 'Zu viele Versuche — bitte eine Stunde warten.' });
  const { current, next: newPw } = req.body || {};
  if (!current || !newPw) return res.status(400).json({ error: 'Eingaben fehlen' });
  if (newPw.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.uid);
  if (!bcrypt.compareSync(current, u.password_hash)) {
    recordPwChange(req.session.uid);
    return res.status(400).json({ error: 'Aktuelles Passwort falsch' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPw, BCRYPT_ROUNDS), req.session.uid);
  recordPwChange(req.session.uid);
  // Rotate session so any stolen session cookie is invalidated
  const savedUid = req.session.uid;
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Sitzungsfehler' });
    req.session.uid = savedUid;
    res.json({ ok: true });
  });
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
  const { title, description='', snoozedUntil, isTodo } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  const cleanDesc = stripUnsafeHtml(description);
  const id = uid();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM topics WHERE meeting_id=?').get(req.params.id).m;
  db.prepare(`INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,is_todo,snoozed_until,created_at,sort_order) VALUES (?,?,?,?,0,'','',?,?,?,?)`)
    .run(id, req.params.id, title.trim(), cleanDesc, isTodo ? 1 : 0, snoozedUntil || '', new Date().toISOString(), maxOrder + 1);
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
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  if (resultDate !== undefined && !isValidDate(resultDate)) return res.status(400).json({ error: 'Ungültiges Ergebnis-Datum' });
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
           dueDate: t.due_date || null,
           isPrivate: !!t.is_private,
           sortOrder: t.sort_order, createdAt: t.created_at };
}

// Sortierung: zuerst nach Fälligkeit (frühestes oben, Todos ohne dueDate ganz unten),
// dann fallback auf sort_order, dann created_at.
const TODOS_ORDER_SQL = `
  ORDER BY
    CASE WHEN due_date='' THEN 1 ELSE 0 END,
    due_date,
    sort_order,
    created_at
`;

app.get(`${A}/todos`, requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT * FROM todos WHERE user_id=? ${TODOS_ORDER_SQL}`).all(req.session.uid).map(parseTodo));
});

app.post(`${A}/todos`, requireAuth, (req, res) => {
  const { title, description='', dueDate, isPrivate, snoozedUntil } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  if (dueDate !== undefined && !isValidDate(dueDate)) return res.status(400).json({ error: 'Ungültiges Fälligkeitsdatum' });
  const id = uid();
  const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM todos WHERE user_id=?').get(req.session.uid).m;
  db.prepare('INSERT INTO todos(id,user_id,title,description,due_date,is_private,snoozed_until,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, req.session.uid, title.trim(), stripUnsafeHtml(description), dueDate || '', isPrivate ? 1 : 0, snoozedUntil || '', mx+1, new Date().toISOString());
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
  const { title=t.title, description=t.description, done, result, resultDate, snoozedUntil, dueDate, isPrivate } = req.body;
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  if (dueDate !== undefined && !isValidDate(dueDate)) return res.status(400).json({ error: 'Ungültiges Fälligkeitsdatum' });
  if (resultDate !== undefined && !isValidDate(resultDate)) return res.status(400).json({ error: 'Ungültiges Ergebnis-Datum' });
  db.prepare('UPDATE todos SET title=?,description=?,done=?,result=?,result_date=?,snoozed_until=?,due_date=?,is_private=?,updated_at=? WHERE id=?').run(
    title, stripUnsafeHtml(description), done !== undefined ? (done?1:0) : t.done,
    stripUnsafeHtml(result ?? t.result), resultDate ?? t.result_date,
    snoozedUntil !== undefined ? (snoozedUntil || '') : t.snoozed_until,
    dueDate !== undefined ? (dueDate || '') : t.due_date,
    isPrivate !== undefined ? (isPrivate ? 1 : 0) : t.is_private,
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
    parentId: t.parent_id || null,
    sortOrder: t.sort_order, createdAt: t.created_at,
    links: links.filter(l => l.theme_id === t.id).map(l => ({
      id: l.id, refType: l.ref_type, refId: l.ref_id,
    })),
  };
}

// Root + all descendants (inclusive) of a theme, via recursive CTE
function themeDescendantIds(rootId, userId) {
  const rows = db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM themes WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT t.id FROM themes t JOIN sub ON t.parent_id = sub.id
    )
    SELECT id FROM sub
  `).all(rootId, userId);
  return rows.map(r => r.id);
}

app.get(`${A}/themes`, requireAuth, (req, res) => {
  const ts = db.prepare('SELECT * FROM themes WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.uid);
  const links = ts.length
    ? db.prepare(`SELECT * FROM theme_links WHERE theme_id IN (${ts.map(()=>'?').join(',')})`)
        .all(...ts.map(t => t.id))
    : [];
  res.json(ts.map(t => parseTheme(t, links)));
});

// Nested tree of all topics belonging to the user
app.get(`${A}/themes/tree`, requireAuth, (req, res) => {
  const ts = db.prepare('SELECT * FROM themes WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.uid);
  const byId = new Map(ts.map(t => [t.id, { ...parseTheme(t), children: [] }]));
  const roots = [];
  for (const t of ts) {
    const node = byId.get(t.id);
    if (t.parent_id && byId.has(t.parent_id)) byId.get(t.parent_id).children.push(node);
    else roots.push(node);
  }
  res.json(roots);
});

app.post(`${A}/themes`, requireAuth, (req, res) => {
  const { title, description='', parentId=null } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  let parent = null;
  if (parentId) {
    parent = db.prepare('SELECT id FROM themes WHERE id=? AND user_id=?').get(parentId, req.session.uid);
    if (!parent) return res.status(400).json({ error: 'Übergeordnetes Topic nicht gefunden' });
  }
  const id = uid();
  const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM themes WHERE user_id=?').get(req.session.uid).m;
  db.prepare('INSERT INTO themes(id,user_id,title,description,parent_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.session.uid, title.trim(), stripUnsafeHtml(description), parent ? parent.id : null, mx + 1, new Date().toISOString());
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

// Move a topic under a new parent (or to root if parentId is null)
app.put(`${A}/themes/:id/move`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { parentId=null } = req.body || {};
  if (parentId) {
    const parent = db.prepare('SELECT id FROM themes WHERE id=? AND user_id=?').get(parentId, req.session.uid);
    if (!parent) return res.status(400).json({ error: 'Übergeordnetes Topic nicht gefunden' });
    if (parentId === t.id) return fail(res, 409, 'SELF_PARENT', 'Ein Topic kann nicht sein eigenes Elternteil sein');
    const descendants = themeDescendantIds(t.id, req.session.uid);
    if (descendants.includes(parentId)) return fail(res, 409, 'CYCLE', 'Zyklus: Ziel ist ein Unter-Topic dieses Topics');
  }
  db.prepare('UPDATE themes SET parent_id=? WHERE id=? AND user_id=?').run(parentId, t.id, req.session.uid);
  res.json({ ok: true });
});

// Preview of what a delete would affect, to drive the confirmation dialog
app.get(`${A}/themes/:id/delete-preview`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT id FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const descendants = themeDescendantIds(t.id, req.session.uid).filter(id => id !== t.id);
  const allIds = [t.id, ...descendants];
  const placeholders = allIds.map(() => '?').join(',');
  const knowledgeCount = db.prepare(
    `SELECT COUNT(DISTINCT knowledge_page_id) as c FROM knowledge_topic_links WHERE theme_id IN (${placeholders})`
  ).get(...allIds).c;
  res.json({ subTopicCount: descendants.length, knowledgePageCount: knowledgeCount });
});

app.delete(`${A}/themes/:id`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const cascade = req.query.cascade === 'true';

  db.transaction(() => {
    if (cascade) {
      const allIds = themeDescendantIds(t.id, req.session.uid);
      const placeholders = allIds.map(() => '?').join(',');
      // Knowledge pages linked only within the deleted subtree are removed too;
      // pages that also link to topics outside the subtree survive.
      const pageIds = db.prepare(
        `SELECT DISTINCT knowledge_page_id as id FROM knowledge_topic_links WHERE theme_id IN (${placeholders})`
      ).all(...allIds).map(r => r.id);
      db.prepare(`DELETE FROM themes WHERE id IN (${placeholders}) AND user_id=?`).run(...allIds, req.session.uid);
      for (const pid of pageIds) {
        const remaining = db.prepare('SELECT COUNT(*) as c FROM knowledge_topic_links WHERE knowledge_page_id=?').get(pid).c;
        if (remaining === 0) db.prepare('DELETE FROM knowledge_pages WHERE id=? AND user_id=?').run(pid, req.session.uid);
      }
    } else {
      // Promote direct children to the deleted topic's parent, then delete just this topic
      db.prepare('UPDATE themes SET parent_id=? WHERE parent_id=? AND user_id=?').run(t.parent_id, t.id, req.session.uid);
      db.prepare('DELETE FROM themes WHERE id=? AND user_id=?').run(t.id, req.session.uid);
    }
  })();

  res.json({ ok: true });
});

app.post(`${A}/themes/:id/links`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { refType, refId } = req.body || {};
  if (!['topic','todo','contact'].includes(refType) || !refId) return res.status(400).json({ error: 'Ungültige Verknüpfung' });
  // Sicherheitsfix: Eigentümerschaft von refId prüfen, BEVOR der Link angelegt wird —
  // sonst könnte ein Nutzer fremde Todos/Themen/Kontakte an sein eigenes Topic hängen.
  if (!ownsRef(req.session.uid, refType, refId)) return res.status(404).json({ error: 'Nicht gefunden' });
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

// Todos linked to this topic, optionally including todos linked to sub-topics.
// Descendant results carry originTheme so the UI can badge where they came from.
app.get(`${A}/themes/:id/todos`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const includeDescendants = req.query.includeDescendants === 'true';
  const themeIds = includeDescendants ? themeDescendantIds(t.id, req.session.uid) : [t.id];
  const themesById = new Map(
    db.prepare(`SELECT id,title FROM themes WHERE id IN (${themeIds.map(()=>'?').join(',')})`).all(...themeIds)
      .map(r => [r.id, r])
  );
  const links = db.prepare(
    `SELECT * FROM theme_links WHERE ref_type='todo' AND theme_id IN (${themeIds.map(()=>'?').join(',')})`
  ).all(...themeIds);
  const seen = new Map(); // todoId -> { todo, originThemeId } — first match wins (direct link preferred)
  for (const l of links) {
    if (seen.has(l.ref_id) && l.theme_id === t.id) continue;
    if (!seen.has(l.ref_id) || l.theme_id === t.id) seen.set(l.ref_id, l.theme_id);
  }
  const todoIds = [...seen.keys()];
  if (!todoIds.length) return res.json([]);
  const todos = db.prepare(
    `SELECT * FROM todos WHERE user_id=? AND id IN (${todoIds.map(()=>'?').join(',')}) ${TODOS_ORDER_SQL}`
  ).all(req.session.uid, ...todoIds);
  res.json(todos.map(td => {
    const originThemeId = seen.get(td.id);
    const origin = themesById.get(originThemeId);
    return {
      ...parseTodo(td),
      originThemeId,
      originThemeTitle: originThemeId === t.id ? null : (origin ? origin.title : null),
    };
  }));
});

// ── Knowledge (Wissensseiten) ────────────────────────────────
function parseKnowledgePage(k, themeIds = [], relatedPageIds = []) {
  return {
    id: k.id, title: k.title, content: k.content,
    sortOrder: k.sort_order, createdAt: k.created_at, updatedAt: k.updated_at,
    themeIds, relatedPageIds,
  };
}

function ownsKnowledgePage(userId, id) {
  return db.prepare('SELECT * FROM knowledge_pages WHERE id=? AND user_id=?').get(id, userId);
}

// Global knowledge listing, optionally filtered by themeId (?themeId=...)
app.get(`${A}/knowledge`, requireAuth, (req, res) => {
  let pages;
  if (req.query.themeId) {
    const t = db.prepare('SELECT id FROM themes WHERE id=? AND user_id=?').get(req.query.themeId, req.session.uid);
    if (!t) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
    pages = db.prepare(`
      SELECT kp.* FROM knowledge_pages kp
      JOIN knowledge_topic_links kl ON kl.knowledge_page_id = kp.id
      WHERE kp.user_id=? AND kl.theme_id=?
      ORDER BY kp.sort_order, kp.created_at
    `).all(req.session.uid, t.id);
  } else {
    pages = db.prepare('SELECT * FROM knowledge_pages WHERE user_id=? ORDER BY sort_order, created_at').all(req.session.uid);
  }
  const pageIds = pages.map(p => p.id);
  const themeIdsByPage = knowledgeThemeIds(db, pageIds);
  const relatedByPage  = knowledgeRelatedIds(db, pageIds);
  res.json(pages.map(p => parseKnowledgePage(p, themeIdsByPage.get(p.id) || [], relatedByPage.get(p.id) || [])));
});

app.post(`${A}/knowledge`, requireAuth, (req, res) => {
  const { title, content = '', themeIds = [] } = req.body || {};
  if (!String(title || '').trim()) return fail(res, 400, 'TITLE_REQUIRED', 'Überschrift erforderlich');
  if (String(title).length > MAX_TITLE) return fail(res, 400, 'TITLE_TOO_LONG', 'Überschrift zu lang', { limit: MAX_TITLE });
  if (String(content).length > MAX_KNOWLEDGE_CONTENT) return fail(res, 400, 'CONTENT_TOO_LONG', 'Inhalt zu lang', { limit: MAX_KNOWLEDGE_CONTENT });

  // themeIds ist optional (A3): unbekannte/fremde IDs werden stillschweigend verworfen statt 400.
  const requestedThemeIds = Array.isArray(themeIds) ? [...new Set(themeIds.filter(x => typeof x === 'string'))] : [];
  const validThemes = requestedThemeIds.length
    ? db.prepare(`SELECT id FROM themes WHERE user_id=? AND id IN (${requestedThemeIds.map(()=>'?').join(',')})`)
        .all(req.session.uid, ...requestedThemeIds)
    : [];
  const appliedThemeIds = validThemes.map(t => t.id);

  const sanitized   = sanitizeKnowledgeHtml(content);
  const contentText = htmlToText(sanitized);
  const id = uid();
  const now = new Date().toISOString();
  const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM knowledge_pages WHERE user_id=?').get(req.session.uid).m;
  db.transaction(() => {
    db.prepare('INSERT INTO knowledge_pages(id,user_id,title,content,content_text,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.session.uid, title.trim(), sanitized, contentText, mx + 1, now, now);
    const ins = db.prepare('INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)');
    for (const themeId of appliedThemeIds) ins.run(uid(), id, themeId, now);
  })();
  res.status(201).json(parseKnowledgePage(db.prepare('SELECT * FROM knowledge_pages WHERE id=?').get(id), appliedThemeIds, []));
});

app.put(`${A}/knowledge/:id`, requireAuth, (req, res) => {
  const k = ownsKnowledgePage(req.session.uid, req.params.id);
  // Kein Existenz-Orakel: gelöscht und fremd liefern denselben Code/Text.
  if (!k) return fail(res, 404, 'KNOWLEDGE_PAGE_GONE', 'Diese Wissensseite existiert nicht mehr.');
  const { title = k.title, content = k.content } = req.body || {};
  if (!String(title || '').trim()) return fail(res, 400, 'TITLE_REQUIRED', 'Überschrift erforderlich');
  if (String(title).length > MAX_TITLE) return fail(res, 400, 'TITLE_TOO_LONG', 'Überschrift zu lang', { limit: MAX_TITLE });
  if (String(content).length > MAX_KNOWLEDGE_CONTENT) return fail(res, 400, 'CONTENT_TOO_LONG', 'Inhalt zu lang', { limit: MAX_KNOWLEDGE_CONTENT });

  const sanitized   = sanitizeKnowledgeHtml(content);
  const contentText = htmlToText(sanitized);
  const now = new Date().toISOString();
  db.prepare('UPDATE knowledge_pages SET title=?,content=?,content_text=?,updated_at=? WHERE id=?')
    .run(String(title).trim(), sanitized, contentText, now, k.id);
  res.json({ ok: true, updatedAt: now });
});

app.delete(`${A}/knowledge/:id`, requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM knowledge_pages WHERE id=? AND user_id=?').run(req.params.id, req.session.uid);
  r.changes ? res.json({ ok: true }) : fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
});

// Replace the full set of topic links for a knowledge page (themeIds darf leer sein)
app.put(`${A}/knowledge/:id/themes`, requireAuth, (req, res) => {
  const k = ownsKnowledgePage(req.session.uid, req.params.id);
  if (!k) return fail(res, 404, 'KNOWLEDGE_PAGE_GONE', 'Diese Wissensseite existiert nicht mehr.');
  const { themeIds } = req.body || {};
  if (!Array.isArray(themeIds)) return fail(res, 400, 'VALIDATION_FAILED', 'themeIds muss ein Array sein');

  const requestedThemeIds = [...new Set(themeIds.filter(x => typeof x === 'string'))];
  const validThemes = requestedThemeIds.length
    ? db.prepare(`SELECT id FROM themes WHERE user_id=? AND id IN (${requestedThemeIds.map(()=>'?').join(',')})`)
        .all(req.session.uid, ...requestedThemeIds)
    : [];
  const appliedThemeIds = validThemes.map(t => t.id);
  // droppedCount bündelt gelöschte UND fremde IDs — kein Auskunfts-Unterschied.
  const droppedCount = requestedThemeIds.length - appliedThemeIds.length;

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM knowledge_topic_links WHERE knowledge_page_id=?').run(k.id);
    const ins = db.prepare('INSERT INTO knowledge_topic_links(id,knowledge_page_id,theme_id,created_at) VALUES (?,?,?,?)');
    for (const themeId of appliedThemeIds) ins.run(uid(), k.id, themeId, now);
  })();
  res.json({ ok: true, appliedThemeIds, droppedCount });
});

// ── Wissensseiten-Verknüpfungen (ungerichtet, Wissensmanagement v2.1, Block A) ──
app.get(`${A}/knowledge/:id/links`, requireAuth, (req, res) => {
  const k = ownsKnowledgePage(req.session.uid, req.params.id);
  if (!k) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
  const rows = db.prepare(`
    SELECT kl.id as link_id, kp.id as page_id, kp.title as page_title, kp.updated_at as page_updated_at
    FROM knowledge_links kl
    JOIN knowledge_pages kp ON kp.id = CASE WHEN kl.page_a_id = ? THEN kl.page_b_id ELSE kl.page_a_id END
    WHERE kl.user_id = ? AND (kl.page_a_id = ? OR kl.page_b_id = ?)
  `).all(k.id, req.session.uid, k.id, k.id);
  res.json(rows.map(r => ({
    linkId: r.link_id,
    page: { id: r.page_id, title: r.page_title, updatedAt: r.page_updated_at },
  })));
});

app.post(`${A}/knowledge/:id/links`, requireAuth, (req, res) => {
  const k = ownsKnowledgePage(req.session.uid, req.params.id);
  if (!k) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
  const { targetId } = req.body || {};
  if (!targetId || typeof targetId !== 'string') {
    return fail(res, 400, 'VALIDATION_FAILED', 'targetId erforderlich');
  }
  if (targetId === k.id) {
    return fail(res, 400, 'VALIDATION_FAILED', 'Eine Wissensseite kann nicht mit sich selbst verknüpft werden.');
  }
  const target = ownsKnowledgePage(req.session.uid, targetId);
  if (!target) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');

  // Ungerichtetheit strukturell erzwingen: IDs lexikografisch sortieren vor dem Insert.
  const [a, b] = k.id < target.id ? [k.id, target.id] : [target.id, k.id];
  const existing = db.prepare('SELECT id FROM knowledge_links WHERE page_a_id=? AND page_b_id=?').get(a, b);
  const pageOut = { id: target.id, title: target.title, updatedAt: target.updated_at };
  if (existing) {
    return res.status(200).json({ linkId: existing.id, created: false, page: pageOut });
  }
  const id = uid();
  db.prepare('INSERT INTO knowledge_links(id,user_id,page_a_id,page_b_id,created_at) VALUES (?,?,?,?,?)')
    .run(id, req.session.uid, a, b, new Date().toISOString());
  res.status(201).json({ linkId: id, created: true, page: pageOut });
});

app.delete(`${A}/knowledge/:id/links/:linkId`, requireAuth, (req, res) => {
  const k = ownsKnowledgePage(req.session.uid, req.params.id);
  if (!k) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
  const existing = db.prepare('SELECT id, page_a_id, page_b_id, user_id FROM knowledge_links WHERE id=?').get(req.params.linkId);
  if (existing) {
    const belongs = existing.user_id === req.session.uid && (existing.page_a_id === k.id || existing.page_b_id === k.id);
    if (!belongs) return fail(res, 404, 'NOT_FOUND', 'Nicht gefunden');
    db.prepare('DELETE FROM knowledge_links WHERE id=?').run(existing.id);
  }
  // Idempotent: war der Link schon weg, ist das ebenfalls ok:true.
  res.json({ ok: true });
});

// ── Wissensseiten-Volltextsuche (FTS5, Wissensmanagement v2.1, Block A) ──
app.get(`${A}/knowledge/search`, requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, results: [] }); // kein DB-Zugriff unter 2 Zeichen

  const ftsQuery = buildFts5Query(q);
  if (!ftsQuery) return res.json({ query: q, results: [] });

  let rows;
  try {
    rows = db.prepare(`
      SELECT ref_id as id, title,
             snippet(search_index, 4, '', '', '…', 20) as snippet
      FROM search_index
      WHERE search_index MATCH ? AND user_id = ? AND ref_type = 'knowledge'
      ORDER BY bm25(search_index)
      LIMIT 50
    `).all(ftsQuery, req.session.uid);
  } catch (e) {
    // Ungültige FTS5-Syntax darf nie zu 500 führen -> leere Trefferliste.
    return res.json({ query: q, results: [] });
  }

  const pageIds = rows.map(r => r.id);
  const themeIdsByPage = knowledgeThemeIds(db, pageIds);
  res.json({
    query: q,
    results: rows.map(r => ({
      id: r.id,
      title: r.title,
      snippet: String(r.snippet || ''),
      themeIds: themeIdsByPage.get(r.id) || [],
    })),
  });
});

// Knowledge pages linked to this topic, optionally including sub-topics' pages.
app.get(`${A}/themes/:id/knowledge`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const includeDescendants = req.query.includeDescendants === 'true';
  const themeIds = includeDescendants ? themeDescendantIds(t.id, req.session.uid) : [t.id];
  const themesById = new Map(
    db.prepare(`SELECT id,title FROM themes WHERE id IN (${themeIds.map(()=>'?').join(',')})`).all(...themeIds)
      .map(r => [r.id, r])
  );
  const links = db.prepare(
    `SELECT * FROM knowledge_topic_links WHERE theme_id IN (${themeIds.map(()=>'?').join(',')})`
  ).all(...themeIds);
  const seen = new Map(); // pageId -> originThemeId, direct link to t.id preferred
  for (const l of links) {
    if (!seen.has(l.knowledge_page_id) || l.theme_id === t.id) seen.set(l.knowledge_page_id, l.theme_id);
  }
  const pageIds = [...seen.keys()];
  if (!pageIds.length) return res.json([]);
  const pages = db.prepare(
    `SELECT * FROM knowledge_pages WHERE user_id=? AND id IN (${pageIds.map(()=>'?').join(',')}) ORDER BY sort_order, created_at`
  ).all(req.session.uid, ...pageIds);
  const themeIdsByPage = knowledgeThemeIds(db, pageIds);
  res.json(pages.map(p => {
    const originThemeId = seen.get(p.id);
    const origin = themesById.get(originThemeId);
    return {
      ...parseKnowledgePage(p, themeIdsByPage.get(p.id) || []),
      originThemeId,
      originThemeTitle: originThemeId === t.id ? null : (origin ? origin.title : null),
    };
  }));
});

// ── Volltextsuche (FTS5) ──────────────────────────────────────
// Parst dieselbe Mehrwort/Phrasen/Ausschluss-Syntax wie die Web-UI (⌘K) und
// übersetzt sie in eine FTS5-MATCH-Query. Jeder Term wird literal gequotet,
// damit FTS5-Sonderzeichen im Suchtext (z. B. Bindestriche) nicht als Operatoren interpretiert werden.
function buildFts5Query(raw) {
  const tokens = [];
  const phraseRe = /"([^"]+)"/g;
  let m; let cleaned = raw;
  while ((m = phraseRe.exec(raw)) !== null) {
    const negate = cleaned[cleaned.indexOf(m[0]) - 1] === '-';
    tokens.push({ text: m[1], negate });
    cleaned = cleaned.replace((negate ? '-' : '') + m[0], '');
  }
  cleaned.trim().split(/\s+/).filter(Boolean).forEach(w => {
    const negate = w.startsWith('-');
    const text = negate ? w.slice(1) : w;
    if (text) tokens.push({ text, negate });
  });
  if (!tokens.length) return null;
  const esc = s => '"' + s.replace(/"/g, '""') + '"';
  const positives = tokens.filter(t => !t.negate && t.text).map(t => esc(t.text));
  const negatives = tokens.filter(t => t.negate && t.text).map(t => esc(t.text));
  if (!positives.length) return null; // FTS5 braucht mind. einen positiven Term
  return positives.join(' ') + negatives.map(n => ` NOT ${n}`).join('');
}

app.get(`${A}/search`, requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const ftsQuery = buildFts5Query(q);
  if (!ftsQuery) return res.json([]);
  let rows;
  try {
    rows = db.prepare(`
      SELECT ref_type, ref_id
      FROM search_index
      WHERE search_index MATCH ? AND user_id = ?
      ORDER BY bm25(search_index)
      LIMIT 200
    `).all(ftsQuery, req.session.uid);
  } catch (e) {
    return res.json([]); // ungültige Query-Syntax (z. B. leere Phrase) -> leeres Ergebnis statt 500
  }
  res.json(rows.map(r => ({ type: r.ref_type, id: r.ref_id })));
});

// ── User routes (admin only) ─────────────────────────────────
app.get(`${A}/users`, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,username,role,created_at,last_active_at FROM users ORDER BY created_at').all());
});

app.post(`${A}/users`, requireAdmin, (req, res) => {
  const { username, password, role='user' } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  if (username.trim().length > 80) return res.status(400).json({ error: 'Benutzername zu lang' });
  if (password.length < 8) return res.status(400).json({ error: 'Passwort mindestens 8 Zeichen' });
  try {
    const id = uid();
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at,last_active_at) VALUES (?,?,?,?,?,?)').run(
      id, username.trim(), bcrypt.hashSync(password, BCRYPT_ROUNDS), role==='admin'?'admin':'user', new Date().toISOString(), ''
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
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, BCRYPT_ROUNDS), req.params.id);
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

// ── KI-Zusammenfassung beim Einfügen von Links ───────────────
// Verhindert, dass ein Nutzer mehrere gleichzeitige Seitenabrufe anstößt
// (Missbrauch als Portscanner / Ressourcenerschöpfung). Rein In-Memory,
// pro Prozess — kein Persistenzbedarf, TTL nicht nötig, da der Eintrag in
// jedem Abschlusspfad (finally) wieder entfernt wird.
const linkFetchInProgress = new Set();
const linkSummarizeInProgress = new Set();

// Zeitfenster-Rate-Limit pro Nutzer für aufeinanderfolgende (nicht nur
// gleichzeitige) Seitenabrufe — Security-Review-Fund: linkFetchInProgress
// allein verhindert nur Parallelität, nicht Serien-Missbrauch als externer
// Abruf-Proxy/Scanner. Rein In-Memory, absichtlich einfach.
const LINK_FETCH_WINDOW_MS = 10 * 60 * 1000;
const LINK_FETCH_MAX_PER_WINDOW = 10;
const linkFetchTimestamps = new Map(); // uid -> number[]
function checkLinkFetchRate(uid) {
  const now = Date.now();
  const arr = (linkFetchTimestamps.get(uid) || []).filter(t => now - t < LINK_FETCH_WINDOW_MS);
  if (arr.length >= LINK_FETCH_MAX_PER_WINDOW) { linkFetchTimestamps.set(uid, arr); return false; }
  arr.push(now);
  linkFetchTimestamps.set(uid, arr);
  return true;
}

// Bewusst nur EIN Test-only-Bypass für die SSRF-Loopback-Sperre von
// lib/safe-fetch.js: `safeFetchPage()` unterstützt laut lib/safe-fetch.js
// eine (im öffentlichen Vertrag von Paket 1 nicht dokumentierte) Option
// `allowLoopbackForTest`, die ausschließlich Loopback-Literale (127.0.0.1,
// ::1) von der Sperre ausnimmt — alle anderen SSRF-Schutzmaßnahmen bleiben
// unverändert aktiv. Damit die Testsuite dieses Pakets einen echten
// lokalen http.createServer() abrufen kann, wird dieser Schalter über eine
// Umgebungsvariable freigeschaltet, die außerhalb von Tests nicht gesetzt
// wird (Default: aus). Bewusst zusätzlich an NODE_ENV=test gebunden (nicht
// nur an die Variable selbst), damit eine versehentlich gesetzte Variable in
// einer Produktionsumgebung (falscher NODE_ENV) wirkungslos bleibt -
// Security-Review-Fund: reines Fail-open ohne diese zweite Bedingung würde
// den SSRF-Loopback-Schutz (inkl. Port-Beschränkung) deaktivieren.
function allowLoopbackForTest() {
  return process.env.NODE_ENV === 'test' && process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST === 'true';
}
if (process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST === 'true' && process.env.NODE_ENV !== 'test') {
  console.warn('[link-summary] ALLOW_LOOPBACK_FETCH_FOR_TEST ist gesetzt, aber NODE_ENV != "test" - SSRF-Testausnahme bleibt inaktiv.');
}
if (process.env.ALLOW_LOOPBACK_FETCH_FOR_TEST === 'true' && process.env.NODE_ENV === 'production') {
  throw new Error('ALLOW_LOOPBACK_FETCH_FOR_TEST darf niemals zusammen mit NODE_ENV=production gesetzt sein.');
}

// Zentrale Fehler-Mapping-Funktion: SafeFetchError/ExtractError -> HTTP.
// Liefert IMMER generische, nutzertaugliche Texte ohne interne Details
// (keine IP-/Hostnamen-/Netzwerkdetails, kein Stacktrace).
function mapLinkFetchError(e) {
  if (e instanceof SafeFetchError) {
    switch (e.code) {
      case 'invalid_url':             return { status: 400, code: e.code, message: 'Keine gültige http/https-Adresse.' };
      case 'blocked_target':          return { status: 403, code: e.code, message: 'Diese Adresse kann nicht abgerufen werden.' };
      case 'too_large':               return { status: 413, code: e.code, message: 'Die Seite ist zu groß.' };
      case 'unsupported_content_type':return { status: 415, code: e.code, message: 'Dieser Inhaltstyp lässt sich nicht zusammenfassen.' };
      case 'fetch_http_error':        return { status: 502, code: e.code, message: 'Die Seite hat mit einem Fehler geantwortet und kann nicht zusammengefasst werden.' };
      case 'too_many_redirects':      return { status: 502, code: e.code, message: 'Zu viele Weiterleitungen.' };
      case 'fetch_timeout':           return { status: 504, code: e.code, message: 'Die Seite hat nicht rechtzeitig geantwortet.' };
      case 'fetch_failed':
      default:                        return { status: 502, code: 'fetch_failed', message: 'Die Seite ist nicht erreichbar.' };
    }
  }
  if (e instanceof ExtractError) {
    return { status: 422, code: 'no_text_content', message: 'Auf der Seite wurde zu wenig Text gefunden.' };
  }
  return { status: 502, code: 'fetch_failed', message: 'Die Seite ist nicht erreichbar.' };
}

app.post(`${A}/ai/link/fetch`, requireAuth, async (req, res) => {
  const uid = req.session.uid;
  const startedAt = Date.now();

  const rawUrl = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!rawUrl) {
    return res.status(400).json({ error: 'Keine gültige http/https-Adresse.', code: 'invalid_url' });
  }

  let s;
  try {
    s = ai.loadSettings(db, uid);
    ai.assertActive(s, 'link_summary');
    aiUsage.assertBudgetOk(db, uid, s, 0);
  } catch (e) { return aiErr(res, e); }

  if (linkFetchInProgress.has(uid)) {
    return res.status(409).json({ error: 'Ein Seitenabruf läuft bereits.', code: 'fetch_in_progress' });
  }
  if (!checkLinkFetchRate(uid)) {
    return res.status(429).json({ error: 'Zu viele Seitenabrufe. Bitte kurz warten.', code: 'rate_limited' });
  }
  linkFetchInProgress.add(uid);

  try {
    let fetched;
    try {
      fetched = await safeFetchPage(rawUrl, {
        timeoutMs: 10000,
        maxBytes: 2 * 1024 * 1024,
        maxRedirects: 3,
        allowLoopbackForTest: allowLoopbackForTest(),
      });
    } catch (e) {
      const mapped = mapLinkFetchError(e);
      // Bei blocked_target zusätzlich die (interne, nicht personenbezogene)
      // User-ID mitloggen, damit wiederholte SSRF-Sondierungsversuche einem
      // Konto zuordenbar sind (Security-Review-Fund) — die URL selbst bleibt
      // weiterhin ungeloggt.
      const logCtx = { code: mapped.code, durationMs: Date.now() - startedAt };
      if (mapped.code === 'blocked_target') logCtx.uid = uid;
      console.warn('[link-summary] fetch failed', logCtx);
      return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }

    let extracted;
    try {
      extracted = extractReadableText(fetched.body, { charset: fetched.charset, maxChars: 12000 });
    } catch (e) {
      const mapped = mapLinkFetchError(e);
      console.warn('[link-summary] extract failed', { code: mapped.code, durationMs: Date.now() - startedAt });
      return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }

    const page = {
      title:    extracted.title,
      text:     extracted.text,
      lang:     extracted.lang,
      finalUrl: fetched.finalUrl,
      truncated: !!extracted.truncated,
    };
    const page_token = linkCache.put(uid, page);

    res.json({
      page_token,
      title: page.title,
      final_url: page.finalUrl,
      lang: page.lang,
      text_chars: page.text.length,
      truncated: page.truncated,
    });
  } finally {
    linkFetchInProgress.delete(uid);
  }
});

const LINK_SUMMARY_VALID_LENGTHS = new Set(['short', 'medium', 'long']);

app.post(`${A}/ai/link/summarize`, requireAuth, async (req, res) => {
  const uid = req.session.uid;
  const body = req.body || {};
  const length = body.length;
  const pageToken = typeof body.page_token === 'string' ? body.page_token : '';

  if (!LINK_SUMMARY_VALID_LENGTHS.has(length)) {
    return res.status(400).json({ error: 'Ungültige Länge.', code: 'invalid_length' });
  }

  // Gleicher Concurrency-Guard wie beim Fetch (Security-Review-Fund): ohne
  // ihn koennten mehrere parallele Anfragen mit demselben page_token alle
  // die Budgetpruefung passieren, bevor der erste Aufruf verbucht ist
  // (Budget-Race), und so das Monatslimit ueberschreiten.
  if (linkSummarizeInProgress.has(uid)) {
    return res.status(409).json({ error: 'Es laeuft bereits eine Zusammenfassung.', code: 'summarize_in_progress' });
  }
  linkSummarizeInProgress.add(uid);

  try {
    const s = ai.loadSettings(db, uid);
    ai.assertActive(s, 'link_summary');
    const page = linkCache.take(uid, pageToken);
    if (!page) {
      return res.status(410).json({ error: 'Der zwischengespeicherte Seiteninhalt ist abgelaufen.', code: 'page_token_expired' });
    }
    const r = await ai.summarizeLink({
      db, userId: uid, settings: s, encryptionKey,
      page, length,
      confirmed: req.query.confirm === 'true',
    });
    res.json(r);
  } catch (e) { aiErr(res, e); }
  finally { linkSummarizeInProgress.delete(uid); }
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
  if (refType === 'contact') {
    return !!db.prepare('SELECT 1 FROM contacts WHERE id=? AND user_id=?').get(refId, uid);
  }
  if (refType === 'theme') {
    return !!db.prepare('SELECT 1 FROM themes WHERE id=? AND user_id=?').get(refId, uid);
  }
  if (refType === 'knowledge') {
    return !!db.prepare('SELECT 1 FROM knowledge_pages WHERE id=? AND user_id=?').get(refId, uid);
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
    // Frame stays open; promote it to the top of the open stack.
    //
    // Pre-state: someChain → oldTop → ... → f → ... → bottom
    // Post-state: f → oldTop → ... (f's old slot is closed by re-linking its child).

    // 1) Determine the current top (using the unmodified chain).
    const allOpen = db.prepare(
      'SELECT * FROM stack_frames WHERE user_id=? AND popped_at IS NULL'
    ).all(req.session.uid);
    const ordered = orderActiveFirst(allOpen);
    const oldTopId = ordered[0]?.id || null;

    if (oldTopId !== f.id) {
      // 2) Re-link: whoever had f as parent now takes f's old parent (cut f out).
      db.prepare('UPDATE stack_frames SET parent_frame_id=? WHERE user_id=? AND popped_at IS NULL AND parent_frame_id=?')
        .run(f.parent_frame_id, req.session.uid, f.id);
      // 3) f becomes the new top — its parent is the old top.
      db.prepare('UPDATE stack_frames SET parent_frame_id=? WHERE id=?').run(oldTopId, f.id);
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

// ── Contacts (Ansprechpartner) ───────────────────────────────
const MAX_CONTACT_NAME = 200;
const MAX_CONTACT_FIELD = 500;

app.get(`${A}/contacts`, requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM contacts WHERE user_id=? ORDER BY sort_order, created_at'
  ).all(req.session.uid);
  res.json(rows.map(parseContact));
});

app.post(`${A}/contacts`, requireAuth, (req, res) => {
  const { name = '', role = '', email = '', description = '' } = req.body || {};
  const cleanName = String(name).trim();
  if (!cleanName) return res.status(400).json({ error: 'Name erforderlich' });
  if (cleanName.length > MAX_CONTACT_NAME) return res.status(400).json({ error: 'Name zu lang' });
  if (String(role).length  > MAX_CONTACT_FIELD) return res.status(400).json({ error: 'Rolle zu lang' });
  if (String(email).length > MAX_CONTACT_FIELD) return res.status(400).json({ error: 'E-Mail zu lang' });

  const id = uid();
  const now = new Date().toISOString();
  const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS m FROM contacts WHERE user_id=?').get(req.session.uid).m;
  db.prepare(
    'INSERT INTO contacts(id,user_id,name,role,email,description,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, req.session.uid, cleanName, String(role).trim(), String(email).trim(),
        stripUnsafeHtml(description || ''), mx + 1, now, now);
  res.status(201).json(parseContact(db.prepare('SELECT * FROM contacts WHERE id=?').get(id)));
});

app.put(`${A}/contacts/reorder`, requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const update = db.prepare('UPDATE contacts SET sort_order=? WHERE id=? AND user_id=?');
  ids.forEach((id, i) => update.run(i, id, req.session.uid));
  res.json({ ok: true });
});

app.put(`${A}/contacts/:id`, requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!c) return res.status(404).json({ error: 'Nicht gefunden' });
  const { name = c.name, role = c.role, email = c.email, description = c.description } = req.body || {};
  const cleanName = String(name).trim();
  if (!cleanName) return res.status(400).json({ error: 'Name erforderlich' });
  if (cleanName.length > MAX_CONTACT_NAME) return res.status(400).json({ error: 'Name zu lang' });
  db.prepare(
    'UPDATE contacts SET name=?, role=?, email=?, description=?, updated_at=? WHERE id=? AND user_id=?'
  ).run(cleanName, String(role).trim(), String(email).trim(),
        stripUnsafeHtml(description || ''), new Date().toISOString(),
        req.params.id, req.session.uid);
  res.json(parseContact(db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id)));
});

app.delete(`${A}/contacts/:id`, requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM contacts WHERE id=? AND user_id=?').run(req.params.id, req.session.uid);
  if (!r.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
});

function parseContact(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    email: r.email,
    description: r.description,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Attachment routes ─────────────────────────────────────────
const ALLOWED_REF_TYPES = new Set(['topic', 'todo', 'knowledge_page']);
const MAX_FILE_SIZE     = 50 * 1024 * 1024; // 50 MB

function checkAttachmentOwnership(refType, refId, uid) {
  if (refType === 'todo') {
    return !!db.prepare('SELECT 1 FROM todos WHERE id=? AND user_id=?').get(refId, uid);
  }
  if (refType === 'topic') {
    return !!db.prepare(
      'SELECT 1 FROM meetings WHERE user_id=? AND id=(SELECT meeting_id FROM topics WHERE id=?)'
    ).get(uid, refId);
  }
  if (refType === 'knowledge_page') {
    return !!db.prepare('SELECT 1 FROM knowledge_pages WHERE id=? AND user_id=?').get(refId, uid);
  }
  return false;
}

// Upload — raw binary, filename + mime via query/header
app.post(`${A}/attachments/:refType/:refId`, requireAuth,
  express.raw({ type: '*/*', limit: '50mb' }),
  (req, res) => {
    const { refType, refId } = req.params;
    if (!ALLOWED_REF_TYPES.has(refType)) return res.status(400).json({ error: 'Ungültiger Typ' });
    if (!checkAttachmentOwnership(refType, refId, req.session.uid))
      return res.status(404).json({ error: 'Nicht gefunden' });

    const origName = req.query.filename
      ? decodeURIComponent(req.query.filename).replace(/[/\\]/g, '_')
      : 'datei';
    const mimeType = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const ext      = path.extname(origName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
    const storedAs = uid() + (ext || '');
    const filePath = path.join(UPLOADS_DIR, storedAs);

    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: 'Keine Dateidaten' });

    fs.writeFileSync(filePath, req.body);
    const id = uid();
    db.prepare(
      'INSERT INTO attachments(id,user_id,ref_type,ref_id,filename,stored_as,mime_type,size,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, req.session.uid, refType, refId, origName, storedAs, mimeType, req.body.length, new Date().toISOString());

    res.status(201).json(parseAttachment(db.prepare('SELECT * FROM attachments WHERE id=?').get(id)));
  }
);

// List
app.get(`${A}/attachments/:refType/:refId`, requireAuth, (req, res) => {
  const { refType, refId } = req.params;
  if (!ALLOWED_REF_TYPES.has(refType)) return res.status(400).json({ error: 'Ungültiger Typ' });
  if (!checkAttachmentOwnership(refType, refId, req.session.uid))
    return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(db.prepare('SELECT * FROM attachments WHERE ref_type=? AND ref_id=? ORDER BY created_at').all(refType, refId).map(parseAttachment));
});

// Download
app.get(`${A}/attachments/download/:id`, requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
  const filePath = path.resolve(UPLOADS_DIR, a.stored_as);
  // Defense-in-depth: ensure resolved path stays within UPLOADS_DIR
  if (!filePath.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) return res.status(400).json({ error: 'Ungültiger Pfad' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Datei nicht gefunden' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  // Force safe content-type to prevent content-sniffing attacks; 'attachment' disposition already mitigates most risk
  const safeMime = /^[\w\-]+\/[\w\-+.]+$/.test(a.mime_type) ? a.mime_type : 'application/octet-stream';
  res.setHeader('Content-Type', safeMime);
  res.sendFile(filePath);
});

// Delete
app.delete(`${A}/attachments/:id`, requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
  const filePath = path.join(UPLOADS_DIR, a.stored_as);
  try { fs.unlinkSync(filePath); } catch (_) { /* already gone */ }
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  res.json({ ok: true });
});

function parseAttachment(a) {
  return {
    id: a.id, refType: a.ref_type, refId: a.ref_id,
    filename: a.filename, mimeType: a.mime_type,
    size: a.size, createdAt: a.created_at,
  };
}

// ── Statische Assets (Graph-Modul: /public/graph.js, graph.css) ──
// Unter beiden Pfaden gemountet, damit `/assets/...` in index.html unabhängig
// von einem konfigurierten BASE_PATH funktioniert.
// graph-dev.html ist eine Entwickler-Harness (Mock-Backend, keine Secrets) und soll
// nicht im Produktionsauslieferungspfad erreichbar sein.
const assetsGuard = (req, res, next) => (req.path.toLowerCase() === '/graph-dev.html') ? res.status(404).end() : next();
const assetsStatic = express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'ignore', etag: true, maxAge: 0 });
app.use('/assets', assetsGuard, assetsStatic);
if (BASE) app.use(`${BASE}/assets`, assetsGuard, assetsStatic);

// ── Frontend ─────────────────────────────────────────────────
app.get(BASE || '/', (req, res) => {
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // Graph-Assets sind im Quelltext auf "/assets/..." verlinkt (funktioniert direkt
  // gegen den Node-Prozess). Hinter einem Reverse-Proxy, der nur BASE_PATH an die
  // App weiterleitet (siehe deploy.sh-Beispielkonfiguration), muss der ausgelieferte
  // Pfad das BASE-Präfix tragen, sonst laedt /assets/graph.js/.css nie.
  if (BASE) {
    html = html
      .replace('href="/assets/graph.css"', `href="${BASE}/assets/graph.css"`)
      .replace('src="/assets/graph.js"', `src="${BASE}/assets/graph.js"`);
  }
  html = html.replace('</head>',
    `<script>window.__TS_BASE__ = ${JSON.stringify(BASE).replace(/</g, '\\u003c')};</script>\n</head>`);
  res.type('text/html').send(html);
});
if (BASE) app.get('/', (req, res) => res.redirect(BASE));

// ── Outlook Add-in ────────────────────────────────────────────
app.get(`${BASE}/addin/manifest.xml`, (req, res) => {
  const proto   = req.headers['x-forwarded-proto'] || req.protocol;
  const host    = req.headers['x-forwarded-host']  || req.get('host');
  const siteUrl = `${proto}://${host}${BASE}`;
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xsi:type="MailApp">
  <Id>7a3f2e1d-bc84-4c59-9012-ef5678901234</Id>
  <Version>1.0.0</Version>
  <ProviderName>ThreadStack</ProviderName>
  <DefaultLocale>de-DE</DefaultLocale>
  <DisplayName DefaultValue="ThreadStack"/>
  <Description DefaultValue="Meetings zuordnen, Todos und Themen direkt aus Outlook erstellen."/>
  <IconUrl DefaultValue="${siteUrl}/addin/icon-64.png"/>
  <HighResolutionIconUrl DefaultValue="${siteUrl}/addin/icon-64.png"/>
  <SupportUrl DefaultValue="${siteUrl}/"/>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.1"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings>
        <SourceLocation DefaultValue="${siteUrl}/addin/"/>
        <RequestedHeight>350</RequestedHeight>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message"     FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Appointment" FormType="Read"/>
  </Rule>
</OfficeApp>`);
});

// Taskpane: BASE_PATH ins HTML einbetten damit der API-Pfad stimmt
app.get(`${BASE}/addin/`, (req, res) => {
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname, 'addin.html'), 'utf8');
  // Inject runtime config before </head>
  html = html.replace('</head>',
    `<script>window.__TS_BASE__ = ${JSON.stringify(BASE).replace(/</g, '\\u003c')};</script>\n</head>`);
  res.type('text/html').send(html);
});

// Fallback icon (einfaches SVG als PNG-Ersatz — Outlook benötigt den Pfad, ignoriert es aber oft)
app.get(`${BASE}/addin/icon-64.png`, (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="12" fill="#6366f1"/>
    <text x="32" y="42" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="bold" fill="white">T</text>
  </svg>`;
  res.type('image/svg+xml').send(svg);
});

// ── Graph-API (Wissensmanagement v2.1, Paket 1b) ──────────────
require('./graph')(app, {
  db,
  requireAuth,
  uid: (req) => req.session.uid,
  ownsRef,
  themeDescendantIds,
  fail,
  htmlToText,
  apiBase: A,
  NODE_TYPES: ['theme', 'knowledge', 'todo', 'topic', 'contact'],
});

// ── Export-API (Web-only Feature) ─────────────────────────────
require('./export')(app, {
  db,
  requireAuth,
  fail,
  apiBase: A,
});

// ── Globaler Error-Handler (letzte Middleware) ────────────────
// Loggt den Stacktrace ausschließlich nach stderr, niemals in der Antwort an
// den Endnutzer (keine internen Details wie Pfade/Query-Strings/Stacktraces).
app.use((err, req, res, next) => {
  console.error(err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Interner Fehler', code: 'INTERNAL_ERROR' });
});

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
