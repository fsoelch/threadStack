'use strict';
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { sanitizeKnowledgeHtml, htmlToText, MAX_KNOWLEDGE_CONTENT } = require('./lib/sanitize');
const { normalizeInlineColorsInHtml } = require('./lib/colors');
const { knowledgeThemeIds, knowledgeRelatedIds } = require('./lib/knowledge-queries');
const { safeFetchPage, SafeFetchError } = require('./lib/safe-fetch');
const { extractReadableText, ExtractError } = require('./lib/html-extract');
const linkCache = require('./ai/link-cache');
const aiUsage = require('./ai/usage');
const progress = require('./lib/progress');
const archive = require('./lib/archive');
const summaries = require('./lib/summaries');
const contacts = require('./lib/contacts');
const assignments = require('./lib/contacts/assignments');
const momentum = require('./lib/momentum');
const backup = require('./lib/backup');
const clientIdem = require('./lib/client-idempotency');
const { createRateLimiter } = require('./lib/rate-limit');
const { runCoreMigrations, rebuildSearchIndex } = require('./db/schema');
let summaryScheduler; // wird nach dem Laden von ai/index.js weiter unten gesetzt

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

// Arbeitspaket B2 (Backup/Restore, Admin, Web-only): eigenes Verzeichnis
// außerhalb von UPLOADS_DIR/public, niemals über express.static erreichbar.
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

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

runCoreMigrations(db, { htmlToText });

// ── Migration: Client-Token-Mapping fuer idempotente Neuanlage (Paket P1,
// Offline-Modus). Braucht users aus den Kern-Migrationen.
clientIdem.runClientIdempotencyMigrations(db);
try {
  clientIdem.purgeExpiredClientTokens(db);
} catch (e) {
  console.error('[client-idempotency] purge failed:', e.message || e);
}

// ── Migration: Zielbild/Fortschrittsverlauf (Arbeitspaket S1/S2) ────
// Additive CREATE TABLE/INDEX IF NOT EXISTS für progress_entries/progress_meta.
// Läuft NACH den Kern-Tabellen (users/todos/topics), da progress_entries.user_id
// auf users(id) referenziert und purgeProgressOrphans() bereits gegen
// existierende todos/topics abgleicht.
progress.runProgressMigrations(db);
// ── Migration: Zwischenstände für Ansprechpartner (Arbeitspaket B2/B4) ──
// MUSS vor contacts.runContactMigrations() laufen: B1 legt dort ggf. bereits
// einen Trigger auf progress_entries für ref_type='contact' an; B2s
// ref_type-Erweiterung (CHECK-Constraint-Rebuild von progress_entries) liest/
// erhält vorhandene Trigger auf progress_entries beim eigenen
// Tabellen-Rebuild, weshalb progress_entries VOR dem Contacts-Trigger-Setup
// bereits den finalen CHECK-Constraint (inkl. 'contact') haben muss. Siehe
// Abschlussberichte B2/B1/B4.
progress.migrateProgressRefTypeContact(db);
progress.purgeProgressOrphans(db);
// ── Migration: Zielbild entfernen (Redesign "Übersichtlichere Todos und
// Tasks", Arbeitspaket S1) ── Idempotent: zweiter Aufruf ist ein No-Op.
progress.dropProgressGoal(db);

// ── Migration: Archiv-Kernmodul (Arbeitspaket B1/B2, "Meetings archivieren
// statt löschen") ────
// Läuft NACH den Progress-Migrationen, da archive_state.user_id auf users(id)
// referenziert und users/meetings zu diesem Zeitpunkt bereits existieren.
archive.runArchiveMigrations(db);
archive.purgeArchiveOrphans(db);

// ── Migration: Ansprechpartner (Kontakte) & Kontakt-Zuständigkeiten
// (Arbeitspaket B1/B3/B4, Ansprechpartner-Erweiterung) ────
// Reihenfolge (verbindlich, siehe Abschlussberichte B1/B2/B3):
// 1) contacts.runContactMigrations() legt contact_categories/
//    contact_info_blocks/contacts.search_text an und setzt (sofern
//    progress_entries bereits im finalen Zustand ist, siehe oben) die
//    Kontakt-Notiz-Trigger auf progress_entries.
// 2) assignments.runAssignmentMigrations() legt contact_assignments an -
//    referenziert contacts(id), muss also NACH runContactMigrations laufen.
// 3) contacts.migrateContactDescriptions() überführt das alte
//    contacts.description-Feld in einen (legacy) Infoblock.
// 4) contacts.ensureContactNoteTriggers() ist eine zusätzliche Absicherung:
//    falls progress_entries beim ersten runContactMigrations()-Lauf (z.B. bei
//    einer künftigen Umsortierung) noch nicht im finalen Zustand war, holt
//    dieser Aufruf das Trigger-Setup + einen Backfill von search_text nach.
// 5) purgeContactOrphans()/purgeAssignmentOrphans() räumen verwaiste
//    theme_links- bzw. contact_assignments-Zeilen auf.
contacts.runContactMigrations(db);
assignments.runAssignmentMigrations(db);
contacts.migrateContactDescriptions(db, { now: () => new Date() });
contacts.ensureContactNoteTriggers(db);
contacts.purgeContactOrphans(db);
assignments.purgeAssignmentOrphans(db);

// ── Migration: Sichtbarer Fortschritt (Arbeitspaket M1/M2) ──────
// Läuft NACH Kontakten/Zuweisungen, da die Meilenstein-Erkennung
// (lib/momentum/completion.js) bereits gegen `contact_assignments`/
// `contacts` abgleicht (rein additiv, keine Reihenfolge-Pflicht, aber
// konsistent mit der sonstigen "Kern zuerst, dann Erweiterungen"-Reihenfolge).
momentum.runMomentumMigrations(db);
momentum.purgeMomentumOrphans(db);

// ── Migration: Backup/Restore (Admin, Web-only, Arbeitspaket B1/B2) ──────
// Rein additiv (Singleton-Zeile backup_settings, referenziert users(id)) -
// läuft nach den Kern-Migrationen, da users bereits existieren muss.
backup.runBackupMigrations(db);

// ── Encryption key for AI provider secrets (analogous to session secret) ──
const ENC_FILE = path.join(DATA_DIR, '.encryption-key');
let encryptionKey;
if (fs.existsSync(ENC_FILE)) {
  encryptionKey = Buffer.from(fs.readFileSync(ENC_FILE, 'utf8').trim(), 'hex');
} else {
  encryptionKey = crypto.randomBytes(32);
  fs.writeFileSync(ENC_FILE, encryptionKey.toString('hex'), { mode: 0o600 });
}

// ── Summaries: verwaiste KI-Zusammenfassungen aufräumen (Paket S3) ──
// Kein automatischer Backfill, nur Aufräumen von Artefakten zu inzwischen
// gelöschten Todos/Topics (z. B. nach Cascade-Deletes).
try { summaries.purgeSummaryOrphans(db); } catch (e) { console.error('[summaries] purge failed:', e.message || e); }

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

// Client-UTC-Offset (Minuten) für den Momentum-Wochenzähler (Arbeitspaket
// M2). Fehlt er oder ist er ungültig, wird UTC (0) angenommen - ein falscher/
// fehlender Zeitzonenwert darf das eigentliche Speichern von Todo/Thema
// niemals verhindern (siehe Architektur-Vertrag M1/M2).
function momentumUtcOffsetMinutes(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= -1440 && n <= 1440 ? n : 0;
}

// Rate-Limit fuer Offline-Outbox-Neuanlagen (POST /todos, POST /meetings/:id/topics).
// 120 pro 10 min und Nutzer: eine Outbox nach einem Offline-Tag (typisch < 100 Eintraege) laeuft
// durch, ein Skript/Fehlverhalten kann die DB aber nicht fluten. 429 + Retry-After; der Client
// klassifiziert 429 als "spaeter erneut" (OfflineSyncAPI.classify).
const createLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 120,
  message: 'Zu viele Anfragen. Bitte später erneut versuchen.',
});

const MAX_TITLE = 300;
const MAX_DESC  = 500_000;

// ── Fehler-Envelope (verbindlich für Wissensmanagement-v2.1-Endpunkte, Block A) ──
// { error: 'Deutscher Klartext', code: 'UPPER_SNAKE_CASE', ...extra }
function fail(res, status, code, msg, extra) {
  res.status(status).json(Object.assign({ error: msg, code }, extra || {}));
}

// Idempotenz-Replay (Paket P1, S-1/S-2): einheitliche Behandlung eines
// vorhandenen Client-Tokens fuer POST /todos und POST /meetings/:id/topics.
// loadRow() liefert die (eigentumsgeprueft geladene) Zeile oder undefined,
// toBody(row) den 200-Body. Liefert true, wenn bereits geantwortet wurde.
function handleClientTokenReplay(res, userId, token, refType, loadRow, toBody) {
  if (!token) return false;
  const hit = clientIdem.lookupClientToken(db, userId, token);
  if (!hit) return false;
  if (hit.refType !== refType) {
    fail(res, 409, 'CLIENT_TOKEN_CONFLICT', 'Client-Token wurde bereits für einen anderen Eintrag verwendet.');
    return true;
  }
  const row = loadRow(hit.refId);
  if (row) {
    res.status(200).json({ ...toBody(row), idempotent: true });
  } else {
    fail(res, 410, 'CLIENT_TOKEN_TARGET_GONE', 'Dieser Eintrag wurde bereits übertragen und inzwischen entfernt.', { refType, refId: hit.refId });
  }
  return true;
}

function stripUnsafeHtml(s) {
  if (!s || typeof s !== 'string') return s;
  // Arbeitspaket 7 (Farb-Persistenz), Security-Nachbesserung: die
  // Farb-Normalisierung MUSS vor der Blacklist laufen, nicht danach.
  // normalizeInlineColorsInHtml entfernt <font>-Tags mit nicht
  // normalisierbarer Farbe und kann dadurch zuvor durch ein eingeschobenes
  // "<...>" zerrissene Payload-Tokens (z.B. "on<font ...>error=") wieder
  // zusammenwachsen lassen. Liefe das NACH der Blacklist, wuerde genau das
  // die bereits entschaerften Tokens (script/onerror/javascript:) wieder
  // herstellen. Reihenfolge spiegelt jetzt den bereits korrekten
  // Allowlist-Pfad in lib/sanitize.js (Vorpass vor sanitizeHtml).
  const normalized = normalizeInlineColorsInHtml(s);
  // Security-Nachbesserung (2. Re-Review): Tag-Entfernungen ersetzen durch
  // ' ' statt '' -- ein ersatzloses '' kann Zeichen davor/danach im String
  // wieder zu einem neuen Tag/Token verschmelzen lassen (z.B. "<scr" +
  // "ipt>" -> "<script>" wenn ein dazwischenliegendes <iframe> entfernt
  // wird, oder "sty" + "le=" -> "style=" wenn ein dazwischenliegendes
  // <script> entfernt wird). Ein Leerzeichen haelt die Tokens getrennt,
  // ohne sichtbaren Text zu veraendern.
  return normalized
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, ' ')
    .replace(/<iframe\b[\s\S]*?(?:<\/iframe\s*>|$)/gi, ' ')
    .replace(/<object\b[\s\S]*?(?:<\/object\s*>|$)/gi, ' ')
    .replace(/<embed\b[^>]*>/gi, ' ')
    .replace(/<base\b[^>]*>/gi, ' ')
    .replace(/<meta\b[^>]*>/gi, ' ')
    .replace(/<form\b[\s\S]*?(?:<\/form\s*>|$)/gi, ' ')
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

// Expliziter Store statt des impliziten express-session-Defaults: nötig,
// damit die Backup-Wiederherstellung (Arbeitspaket B2) nach einem Restore
// per `sessionStore.clear()` gezielt ALLE Sitzungen invalidieren kann (siehe
// Architektur-Sicherheitskonzept). Verhalten sonst unverändert (MemoryStore
// war bereits der implizite Default).
const sessionStore = new session.MemoryStore();

app.use(session({
  secret: sessionSecret,
  store: sessionStore,
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
// Neutrale "keine KI-Zusammenfassung"-Ansicht (Paket S3, Schnittstelle 8/9).
const NA_SUMMARY = Object.freeze({ status: 'not_applicable', text: null, generatedAt: null, model: null, errorCode: null });
const NA_SUMMARY_PAIR = Object.freeze({ progress: NA_SUMMARY, description: NA_SUMMARY });

function parseMeeting(m, topics = [], summaryMap = null) {
  return {
    id: m.id, title: m.title, description: m.description, color: m.color,
    participants: JSON.parse(m.participants || '[]'),
    isRecurring: !!m.is_recurring, recurrencePattern: m.recurrence_pattern,
    nextDate: m.next_date, createdAt: m.created_at,
    topics: topics.filter(t => t.meeting_id === m.id).map(t => parseTopic(t, summaryMap)),
  };
}
function parseTopic(t, summaryMap = null) {
  const base = {
    id: t.id, meetingId: t.meeting_id, title: t.title, description: t.description,
    done: !!t.done, result: t.result, resultDate: t.result_date, createdAt: t.created_at,
    sortOrder: t.sort_order, isTodo: !!t.is_todo, groupId: t.group_id ?? null,
    snoozedUntil: t.snoozed_until || null,
  };
  if (summaryMap) base.aiSummary = summaryMap.get(`topic:${t.id}`) || NA_SUMMARY_PAIR;
  return base;
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
  // Archivierte Meetings werden hier bewusst ausgeblendet (Arbeitspaket B2,
  // "Meetings archivieren statt löschen") - sie sind ausschließlich über
  // GET /api/archive/meetings erreichbar.
  const ms = db.prepare(
    `SELECT m.* FROM meetings m WHERE m.user_id=? AND ${archive.notArchivedSql('m')} ORDER BY m.sort_order, m.created_at`
  ).all(req.session.uid);
  const ts = ms.length
    ? db.prepare(`SELECT * FROM topics WHERE meeting_id IN (${ms.map(()=>'?').join(',')}) ORDER BY sort_order, created_at`).all(...ms.map(m=>m.id))
    : [];
  // Additive Progress-Anreicherung (Fortschrittsverlauf): EINE Batch-Query
  // über summaryFor() für alle Topics dieser Meetings (kein N+1) - Ergebnis
  // wird nachträglich in die bereits geparsten Topic-Objekte gejoint, ohne
  // parseMeeting()/parseTopic() selbst anzufassen.
  const topicItems = ts.map(t => ({
    refType: 'topic', refId: t.id,
    refCreatedAt: t.created_at, refUpdatedAt: t.updated_at,
    refDone: !!t.done, refSnoozedUntil: t.snoozed_until || null,
  }));
  const progressMap = progress.summaryFor(db, req.session.uid, topicItems);
  // Additive KI-Zusammenfassungs-Anreicherung (Paket S3): EIN forRefs()-Aufruf
  // für alle Topics dieser Meetings (kein N+1), niemals ein KI-Aufruf hier.
  const summaryItems = ts.map(t => ({ refType: 'topic', refId: t.id }));
  const summarySettings = ai.loadSettings(db, req.session.uid);
  const summaryMap = summaries.forRefs(db, req.session.uid, summaryItems, { settings: summarySettings, scheduler: summaryScheduler });
  // Additive Zuständigkeits-Anreicherung (Ansprechpartner-Erweiterung,
  // Arbeitspaket B3/B4): EIN contactsForRefs()-Aufruf für alle Topics dieser
  // Meetings (kein N+1), analog zum Progress-/KI-Zusammenfassungs-Muster oben.
  const contactsMap = assignments.contactsForRefs(db, req.session.uid, topicItems);
  const meetings = ms.map(m => parseMeeting(m, ts));
  for (const meeting of meetings) {
    for (const topic of meeting.topics) {
      topic.progress = progressMap.get(`topic:${topic.id}`) ?? null;
      topic.aiSummary = summaryMap.get(`topic:${topic.id}`) ?? null;
      topic.contacts = contactsMap.get(`topic:${topic.id}`) ?? [];
    }
  }
  res.json(meetings);
});

app.post(`${A}/meetings`, requireAuth, (req, res) => {
  const { title, description='', participants=[], isRecurring=false, recurrencePattern='', nextDate='', color='#4f46e5' } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (title.length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (!isValidHexColor(color)) return res.status(400).json({ error: 'Ungültige Farbe' });
  const cleanDesc = stripUnsafeHtml(description);
  const id = uid();
  const mxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM meetings WHERE user_id=?').get(req.session.uid).m;
  db.prepare('INSERT INTO meetings(id,user_id,title,description,participants,is_recurring,recurrence_pattern,next_date,color,created_at,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    id, req.session.uid, title.trim(), cleanDesc, JSON.stringify(participants),
    isRecurring?1:0, recurrencePattern, nextDate, color, new Date().toISOString(), mxOrder + 1
  );
  res.status(201).json(parseMeeting(db.prepare('SELECT * FROM meetings WHERE id=?').get(id)));
});

app.put(`${A}/meetings/reorder`, requireAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids erforderlich' });
  // Archivierte Meetings werden hier still ignoriert (kein Fehler) - sie
  // tauchen in der vom Client gesendeten Reorder-Liste ohnehin nicht mehr
  // auf, da GET /api/meetings sie nicht mehr liefert.
  const update = db.prepare(
    `UPDATE meetings SET sort_order=? WHERE id=? AND user_id=? AND ${archive.notArchivedSql('meetings')}`
  );
  db.transaction(() => ids.forEach((id, i) => update.run(i, id, req.session.uid)))();
  res.json({ ok: true });
});

app.put(`${A}/meetings/:id`, requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!m) return res.status(404).json({ error: 'Nicht gefunden' });
  if (meetingArchivedGuard(res, m.id)) return;
  const { title=m.title, description=m.description, participants, isRecurring, recurrencePattern, nextDate, color=m.color } = req.body || {};
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (!isValidHexColor(color)) return res.status(400).json({ error: 'Ungültige Farbe' });
  const cleanDesc = stripUnsafeHtml(description);
  db.prepare('UPDATE meetings SET title=?,description=?,participants=?,is_recurring=?,recurrence_pattern=?,next_date=?,color=? WHERE id=?').run(
    title, cleanDesc,
    JSON.stringify(participants ?? JSON.parse(m.participants)),
    isRecurring !== undefined ? (isRecurring?1:0) : m.is_recurring,
    recurrencePattern ?? m.recurrence_pattern,
    nextDate ?? m.next_date,
    color, m.id
  );
  res.json({ ok: true });
});

app.delete(`${A}/meetings/:id`, requireAuth, (req, res) => {
  // SQLite kaskadiert topics.meeting_id (ON DELETE CASCADE) automatisch beim
  // Löschen des Meetings — die betroffenen Topic-IDs müssen daher VORHER
  // eingesammelt werden, damit der Fortschrittsverlauf (progress_entries/
  // progress_meta), die Kontakt-Zuständigkeiten (contact_assignments) UND
  // die KI-Zusammenfassungen (Paket S3) für diese Topics ebenfalls sofort
  // aufgeräumt werden.
  const topicIds = db.prepare('SELECT id FROM topics WHERE meeting_id=?').all(req.params.id).map(r => r.id);
  const r = db.prepare('DELETE FROM meetings WHERE id=? AND user_id=?').run(req.params.id, req.session.uid);
  if (!r.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  if (topicIds.length) {
    progress.deleteForRefs(db, topicIds.map(id => ({ refType: 'topic', refId: id })));
    assignments.deleteForRefs(db, topicIds.map(id => ({ refType: 'topic', refId: id })));
    try { summaries.deleteForRefs(db, req.session.uid, topicIds.map(id => ({ refType: 'topic', refId: id }))); }
    catch (_) { /* best effort */ }
  }
  // Security-Review-Nachbesserung (Arbeitspaket B2): Falls das Meeting zuvor
  // archiviert war, bleibt sonst eine verwaiste archive_state-Zeile zurück
  // (räumt sich sonst erst beim nächsten Serverstart per purgeArchiveOrphans auf).
  archive.deleteState(db, 'meeting', req.params.id);
  res.json({ ok: true });
});

// ── Topic routes ─────────────────────────────────────────────
function ownsMeeting(uid, mid) {
  return !!db.prepare('SELECT 1 FROM meetings WHERE id=? AND user_id=?').get(mid, uid);
}

// ── Schreibschutz für archivierte Meetings/Topics (Arbeitspaket B2,
//    "Meetings archivieren statt löschen") ────────────────────
// Einheitlicher 409-Envelope für JEDEN Schreibversuch auf ein archiviertes
// Meeting oder eines seiner Topics. Der Aufrufer MUSS die Ownership bereits
// vorher geprüft haben (404 statt 409 bei fremden/unbekannten IDs) - diese
// Guards prüfen ausschließlich den Archiv-Zustand.
function failArchivedReadOnly(res) {
  fail(res, 409, 'ARCHIVED_READONLY', 'Dieses Meeting ist archiviert. Zum Bearbeiten bitte wiederherstellen.');
}
function meetingArchivedGuard(res, meetingId) {
  if (archive.isArchived(db, 'meeting', meetingId)) {
    failArchivedReadOnly(res);
    return true;
  }
  return false;
}
function topicArchivedGuard(res, topicId) {
  if (archive.isTopicArchived(db, topicId)) {
    failArchivedReadOnly(res);
    return true;
  }
  return false;
}

// Batch-Lookup "ist das Meeting dieses Topics archiviert?" für eine Liste von
// Topic-IDs (z.B. Suchtreffer, Theme-Links) - EINE Query für die
// Topic->Meeting-Auflösung plus EIN archivedFlags()-Batch-Lookup (kein N+1),
// analog zum Muster in lib/archive/queries.js::archivedFlags.
// @returns {Map<string, boolean>} topicId -> archived
function archivedFlagsForTopics(topicIds) {
  const result = new Map();
  const ids = [...new Set((topicIds || []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return result;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, meeting_id FROM topics WHERE id IN (${placeholders})`).all(...ids);
  const meetingIds = [...new Set(rows.map((r) => r.meeting_id))];
  const flags = archive.archivedFlags(db, meetingIds.map((id) => ({ refType: 'meeting', refId: id })));
  for (const r of rows) result.set(r.id, flags.get(`meeting:${r.meeting_id}`) === true);
  return result;
}

app.post(`${A}/meetings/:id/topics`, requireAuth, createLimiter, (req, res) => {
  const body = req.body || {};
  const tok = clientIdem.parseClientToken(body.clientToken);
  if (!tok.ok) return fail(res, 400, 'INVALID_CLIENT_TOKEN', 'Ungültiges Client-Token.');
  if (handleClientTokenReplay(res, req.session.uid, tok.token, 'topic',
    (id) => db.prepare('SELECT t.* FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=? AND m.user_id=?').get(id, req.session.uid),
    (row) => ({ ...parseTopic(row), contacts: [] }))) return;
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  if (meetingArchivedGuard(res, req.params.id)) return;
  const { title, description='', snoozedUntil, isTodo } = body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  const cap = clientIdem.parseCapturedAt(body.capturedAt);
  if (!cap.ok) return fail(res, 400, 'INVALID_CAPTURED_AT', 'Ungültiger Erfassungszeitpunkt.');
  const cleanDesc = stripUnsafeHtml(description);
  const id = uid();
  const nowIso = new Date().toISOString();
  // Parallele Erst-Requests mit demselben Token (z.B. zweiter Prozess): der zweite scheitert am PK
  // (user_id, client_token), die Transaktion rollt komplett zurueck (kein Duplikat). Statt 500
  // wird der Replay-Pfad ausgefuehrt (200 mit dem bereits angelegten Eintrag).
  try { db.transaction(() => {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM topics WHERE meeting_id=?').get(req.params.id).m;
    db.prepare(`INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,is_todo,snoozed_until,created_at,sort_order) VALUES (?,?,?,?,0,'','',?,?,?,?)`)
      .run(id, req.params.id, title.trim(), cleanDesc, isTodo ? 1 : 0, snoozedUntil || '', cap.iso || nowIso, maxOrder + 1);
    if (tok.token) clientIdem.recordClientToken(db, { userId: req.session.uid, token: tok.token, refType: 'topic', refId: id, nowIso });
  })(); } catch (e) {
    if (tok.token && e && e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
      && handleClientTokenReplay(res, req.session.uid, tok.token, 'topic',
        (rid) => db.prepare('SELECT t.* FROM topics t JOIN meetings m ON m.id=t.meeting_id WHERE t.id=? AND m.user_id=?').get(rid, req.session.uid),
        (row) => ({ ...parseTopic(row), contacts: [] }))) return;
    throw e;
  }
  // Neuanlage: noch keine Zuständigkeiten möglich -> immer leeres Array
  // (konsistent mit der contactsForRefs()-Anreicherung in GET /meetings).
  res.status(201).json({ ...parseTopic(db.prepare('SELECT * FROM topics WHERE id=?').get(id)), contacts: [] });
});

app.put(`${A}/meetings/:id/topics/reorder`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  if (meetingArchivedGuard(res, req.params.id)) return;
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids erforderlich' });
  const update = db.prepare('UPDATE topics SET sort_order=? WHERE id=? AND meeting_id=?');
  db.transaction(() => ids.forEach((id, i) => update.run(i, id, req.params.id)))();
  res.json({ ok: true });
});

app.post(`${A}/meetings/:id/topics/:tid/share`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const t = db.prepare('SELECT * FROM topics WHERE id=? AND meeting_id=?').get(req.params.tid, req.params.id);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  // Quell-Meeting archiviert -> 409 (der aktuell bearbeitete Kontext).
  if (meetingArchivedGuard(res, req.params.id)) return;
  const { targetMeetingId } = req.body || {};
  if (!targetMeetingId) return res.status(400).json({ error: 'targetMeetingId erforderlich' });
  if (!ownsMeeting(req.session.uid, targetMeetingId)) return res.status(404).json({ error: 'Ziel-Meeting nicht gefunden' });
  // Ziel-Meeting archiviert -> 404 (kein 409, das Ziel ist nicht der aktuell
  // bearbeitete Kontext - identische Antwort wie "Ziel-Meeting existiert nicht").
  if (archive.isArchived(db, 'meeting', targetMeetingId)) return res.status(404).json({ error: 'Ziel-Meeting nicht gefunden' });
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
  // Quell-Meeting archiviert -> 409, sowohl für "Verschieben" als auch
  // "In persönliches Todo umwandeln" (beide mutieren die Quelle).
  if (meetingArchivedGuard(res, req.params.id)) return;
  const { targetMeetingId } = req.body || {};

  if (targetMeetingId) {
    // ── Move to another meeting ────────────────────────────────
    if (targetMeetingId === req.params.id) return res.status(400).json({ error: 'Quelle und Ziel sind identisch' });
    if (!ownsMeeting(req.session.uid, targetMeetingId)) return res.status(404).json({ error: 'Ziel-Meeting nicht gefunden' });
    // Ziel-Meeting archiviert -> 404 (kein 409, siehe .../share-Route oben).
    if (archive.isArchived(db, 'meeting', targetMeetingId)) return res.status(404).json({ error: 'Ziel-Meeting nicht gefunden' });
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
    // Transfer Kontakt-Zuständigkeiten (Ansprechpartner-Erweiterung, B3/B4):
    // sonst gehen bestehende Zuordnungen bei der Konvertierung verloren.
    assignments.moveAssignments(db, { refType: 'topic', refId: t.id }, { refType: 'todo', refId: id });
    // Dissolve group if needed
    if (t.group_id) {
      const remaining = db.prepare('SELECT id FROM topics WHERE group_id=? AND id!=?').all(t.group_id, t.id);
      if (remaining.length === 1) db.prepare('UPDATE topics SET group_id=NULL WHERE id=?').run(remaining[0].id);
    }
    db.prepare('DELETE FROM topics WHERE id=?').run(t.id);
    progress.retargetRef(db, 'topic', t.id, 'todo', id);
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
  // Ziel-Meeting archiviert -> 404 (das Todo selbst ist nicht archivierbar,
  // daher nur der Ziel-Guard - analog .../topics/:tid/move).
  if (archive.isArchived(db, 'meeting', targetMeetingId)) return res.status(404).json({ error: 'Meeting nicht gefunden' });
  const id = uid();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM topics WHERE meeting_id=?').get(targetMeetingId).m;
  db.prepare('INSERT INTO topics(id,meeting_id,title,description,done,result,result_date,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, targetMeetingId, t.title, t.description, t.done, t.result, t.result_date, maxOrder + 1, new Date().toISOString());
  // Transfer theme_links to the new topic
  db.prepare('UPDATE theme_links SET ref_type=?, ref_id=? WHERE ref_type=? AND ref_id=?').run('topic', id, 'todo', t.id);
  // Transfer Kontakt-Zuständigkeiten (Ansprechpartner-Erweiterung, B3/B4):
  // sonst gehen bestehende Zuordnungen bei der Konvertierung verloren.
  assignments.moveAssignments(db, { refType: 'todo', refId: t.id }, { refType: 'topic', refId: id });
  db.prepare('DELETE FROM todos WHERE id=?').run(t.id);
  progress.retargetRef(db, 'todo', t.id, 'topic', id);
  res.json({ ok: true, targetMeetingId, newId: id });
});

app.put(`${A}/meetings/:id/topics/:tid`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const t = db.prepare('SELECT * FROM topics WHERE id=? AND meeting_id=?').get(req.params.tid, req.params.id);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  if (topicArchivedGuard(res, t.id)) return;
  const { title=t.title, description=t.description, done, result, resultDate, isTodo, snoozedUntil, utcOffsetMinutes } = req.body || {};
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  if (resultDate !== undefined && !isValidDate(resultDate)) return res.status(400).json({ error: 'Ungültiges Ergebnis-Datum' });
  const cleanDesc = stripUnsafeHtml(description);
  const descriptionChanged = cleanDesc !== t.description;
  const doneChanged = done !== undefined && !!done !== !!t.done;
  const nowDate = new Date();
  const nowIso = nowDate.toISOString();
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
  let groupMemberIds = [];
  if (t.group_id) {
    db.prepare('UPDATE topics SET title=?, description=?, updated_at=? WHERE group_id=? AND id!=?')
      .run(title, cleanDesc, nowIso, t.group_id, t.id);
    if (descriptionChanged) {
      groupMemberIds = db.prepare('SELECT id FROM topics WHERE group_id=? AND id!=?').all(t.group_id, t.id).map(r => r.id);
    }
  }
  const responseBody = { ok: true };
  if (descriptionChanged) {
    let pendingSummary = false;
    try {
      const r = summaries.onDescriptionChanged({ userId: req.session.uid, refType: 'topic', refId: t.id, reason: 'updated' });
      pendingSummary = !!(r && r.enqueued);
    } catch (_) { /* best effort — Zusammenfassung darf das Speichern nie verhindern */ }
    for (const memberId of groupMemberIds) {
      try { summaries.onDescriptionChanged({ userId: req.session.uid, refType: 'topic', refId: memberId, reason: 'updated' }); }
      catch (_) { /* best effort */ }
    }
    responseBody.aiSummary = { pending: pendingSummary };
  }
  // Sichtbarer Fortschritt (Arbeitspaket M1/M2): additives Feld, kein
  // Extra-Request für den Erledigt-Moment-Toast (siehe Architektur-Vertrag).
  // Ein Thema (topics) hat KEINE Kind-Todos - jeder Abschluss ist laut
  // fachlicher Entscheidung automatisch ein Meilenstein (siehe
  // lib/momentum/completion.js).
  if (doneChanged) {
    try {
      const offsetMinutes = momentumUtcOffsetMinutes(utcOffsetMinutes);
      const { milestones } = momentum.applyTopicDoneChange(db, { topicId: t.id, userId: req.session.uid, done: !!done, topicTitle: title, now: nowDate });
      const weeklyCompletedCount = momentum.weeklyCompletedCount(db, { userId: req.session.uid, utcOffsetMinutes: offsetMinutes, now: nowDate });
      responseBody.momentum = { weeklyCompletedCount, milestones };
    } catch (e) {
      console.error('[momentum] topic completion hook failed:', e.message || e);
    }
  }
  res.json(responseBody);
});

app.delete(`${A}/meetings/:id/topics/:tid`, requireAuth, (req, res) => {
  if (!ownsMeeting(req.session.uid, req.params.id)) return res.status(404).json({ error: 'Nicht gefunden' });
  const t = db.prepare('SELECT * FROM topics WHERE id=? AND meeting_id=?').get(req.params.tid, req.params.id);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  if (topicArchivedGuard(res, t.id)) return;
  db.prepare('DELETE FROM theme_links WHERE ref_type=? AND ref_id=?').run('topic', t.id);
  try { summaries.deleteForRefs(db, req.session.uid, [{ refType: 'topic', refId: t.id }]); } catch (_) { /* best effort */ }
  db.prepare('DELETE FROM topics WHERE id=?').run(t.id);
  progress.deleteForRefs(db, [{ refType: 'topic', refId: t.id }]);
  assignments.deleteForRefs(db, [{ refType: 'topic', refId: t.id }]);
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
  const rows = db.prepare(`SELECT * FROM todos WHERE user_id=? ${TODOS_ORDER_SQL}`).all(req.session.uid);
  // Additive Progress-Anreicherung (Fortschrittsverlauf): EINE Batch-Query
  // über summaryFor() für alle geladenen Todos (kein N+1).
  const items = rows.map(t => ({
    refType: 'todo', refId: t.id,
    refCreatedAt: t.created_at, refUpdatedAt: t.updated_at,
    refDone: !!t.done, refSnoozedUntil: t.snoozed_until || null,
  }));
  const progressMap = progress.summaryFor(db, req.session.uid, items);
  // Additive KI-Zusammenfassungs-Anreicherung (Paket S3): EIN forRefs()-Aufruf
  // für alle geladenen Todos (kein N+1), niemals ein KI-Aufruf hier.
  const summaryItems = rows.map(t => ({ refType: 'todo', refId: t.id }));
  const summarySettings = ai.loadSettings(db, req.session.uid);
  const summaryMap = summaries.forRefs(db, req.session.uid, summaryItems, { settings: summarySettings, scheduler: summaryScheduler });
  // Additive Zuständigkeits-Anreicherung (Ansprechpartner-Erweiterung,
  // Arbeitspaket B3/B4): EIN contactsForRefs()-Aufruf für alle geladenen
  // Todos (kein N+1), analog zum Progress-/KI-Zusammenfassungs-Muster oben.
  const contactsMap = assignments.contactsForRefs(db, req.session.uid, items);
  res.json(rows.map(t => {
    const todo = parseTodo(t);
    todo.progress = progressMap.get(`todo:${t.id}`) ?? null;
    todo.aiSummary = summaryMap.get(`todo:${t.id}`) || NA_SUMMARY_PAIR;
    todo.contacts = contactsMap.get(`todo:${t.id}`) ?? [];
    return todo;
  }));
});

app.post(`${A}/todos`, requireAuth, createLimiter, (req, res) => {
  const body = req.body || {};
  const tok = clientIdem.parseClientToken(body.clientToken);
  if (!tok.ok) return fail(res, 400, 'INVALID_CLIENT_TOKEN', 'Ungültiges Client-Token.');
  if (handleClientTokenReplay(res, req.session.uid, tok.token, 'todo',
    (id) => db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(id, req.session.uid),
    (row) => ({ ...parseTodo(row), aiSummary: { pending: false }, contacts: [] }))) return;
  const { title, description='', dueDate, isPrivate, snoozedUntil } = body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titel erforderlich' });
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (String(description).length > MAX_DESC) return res.status(400).json({ error: 'Beschreibung zu lang' });
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  if (dueDate !== undefined && !isValidDate(dueDate)) return res.status(400).json({ error: 'Ungültiges Fälligkeitsdatum' });
  const cap = clientIdem.parseCapturedAt(body.capturedAt);
  if (!cap.ok) return fail(res, 400, 'INVALID_CAPTURED_AT', 'Ungültiger Erfassungszeitpunkt.');
  const id = uid();
  const nowIso = new Date().toISOString();
  // Parallele Erst-Requests mit demselben Token (z.B. zweiter Prozess): der zweite scheitert am PK
  // (user_id, client_token), die Transaktion rollt komplett zurueck (kein Duplikat). Statt 500
  // wird der Replay-Pfad ausgefuehrt (200 mit dem bereits angelegten Eintrag).
  try { db.transaction(() => {
    const mx = db.prepare('SELECT COALESCE(MAX(sort_order),-1) as m FROM todos WHERE user_id=?').get(req.session.uid).m;
    db.prepare('INSERT INTO todos(id,user_id,title,description,due_date,is_private,snoozed_until,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, req.session.uid, title.trim(), stripUnsafeHtml(description), dueDate || '', isPrivate ? 1 : 0, snoozedUntil || '', mx+1, cap.iso || nowIso);
    if (tok.token) clientIdem.recordClientToken(db, { userId: req.session.uid, token: tok.token, refType: 'todo', refId: id, nowIso });
  })(); } catch (e) {
    if (tok.token && e && e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
      && handleClientTokenReplay(res, req.session.uid, tok.token, 'todo',
        (rid) => db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(rid, req.session.uid),
        (row) => ({ ...parseTodo(row), aiSummary: { pending: false }, contacts: [] }))) return;
    throw e;
  }
  let pendingSummary = false;
  try {
    const r = summaries.onDescriptionChanged({ userId: req.session.uid, refType: 'todo', refId: id, reason: 'created' });
    pendingSummary = !!(r && r.enqueued);
  } catch (_) { /* best effort — Zusammenfassung darf das Anlegen nie verhindern */ }
  // Neuanlage: noch keine Zuständigkeiten möglich -> immer leeres Array
  // (konsistent mit der contactsForRefs()-Anreicherung in GET /todos).
  res.status(201).json({ ...parseTodo(db.prepare('SELECT * FROM todos WHERE id=?').get(id)), aiSummary: { pending: pendingSummary }, contacts: [] });
});

app.put(`${A}/todos/reorder`, requireAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids erforderlich' });
  const upd = db.prepare('UPDATE todos SET sort_order=? WHERE id=? AND user_id=?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id, req.session.uid)))();
  res.json({ ok: true });
});

app.put(`${A}/todos/:id`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { title=t.title, description=t.description, done, result, resultDate, snoozedUntil, dueDate, isPrivate, utcOffsetMinutes } = req.body || {};
  if (String(title).length > MAX_TITLE) return res.status(400).json({ error: 'Titel zu lang' });
  if (snoozedUntil !== undefined && !isValidDate(snoozedUntil)) return res.status(400).json({ error: 'Ungültiges Schlafen-bis-Datum' });
  if (dueDate !== undefined && !isValidDate(dueDate)) return res.status(400).json({ error: 'Ungültiges Fälligkeitsdatum' });
  if (resultDate !== undefined && !isValidDate(resultDate)) return res.status(400).json({ error: 'Ungültiges Ergebnis-Datum' });
  const cleanDesc = stripUnsafeHtml(description);
  const descriptionChanged = cleanDesc !== t.description;
  const doneChanged = done !== undefined && !!done !== !!t.done;
  const nowDate = new Date();
  db.prepare('UPDATE todos SET title=?,description=?,done=?,result=?,result_date=?,snoozed_until=?,due_date=?,is_private=?,updated_at=? WHERE id=?').run(
    title, cleanDesc, done !== undefined ? (done?1:0) : t.done,
    stripUnsafeHtml(result ?? t.result), resultDate ?? t.result_date,
    snoozedUntil !== undefined ? (snoozedUntil || '') : t.snoozed_until,
    dueDate !== undefined ? (dueDate || '') : t.due_date,
    isPrivate !== undefined ? (isPrivate ? 1 : 0) : t.is_private,
    nowDate.toISOString(),
    t.id);
  const responseBody = { ok: true };
  if (descriptionChanged) {
    let pendingSummary = false;
    try {
      const r = summaries.onDescriptionChanged({ userId: req.session.uid, refType: 'todo', refId: t.id, reason: 'updated' });
      pendingSummary = !!(r && r.enqueued);
    } catch (_) { /* best effort */ }
    responseBody.aiSummary = { pending: pendingSummary };
  }
  // Sichtbarer Fortschritt (Arbeitspaket M1/M2): additives Feld, kein
  // Extra-Request für den Erledigt-Moment-Toast (siehe Architektur-Vertrag).
  // Läuft NACH dem obigen UPDATE, damit der `done`-Zustand bereits final ist.
  if (doneChanged) {
    try {
      const offsetMinutes = momentumUtcOffsetMinutes(utcOffsetMinutes);
      const { milestones } = momentum.applyTodoDoneChange(db, { todoId: t.id, userId: req.session.uid, done: !!done, now: nowDate });
      const weeklyCompletedCount = momentum.weeklyCompletedCount(db, { userId: req.session.uid, utcOffsetMinutes: offsetMinutes, now: nowDate });
      responseBody.momentum = { weeklyCompletedCount, milestones };
    } catch (e) {
      console.error('[momentum] todo completion hook failed:', e.message || e);
    }
  }
  res.json(responseBody);
});

// Setzt die Topic-Zuordnungen eines Todos atomar (ersetzt alle bisherigen
// theme_links vom Typ 'todo' für dieses Todo) - Pendant zu PUT /knowledge/:id/themes,
// damit Topics einem Todo auch manuell (statt nur beim Anlegen aus einem
// Topic-Kontext heraus) zugeordnet werden können.
app.put(`${A}/todos/:id/themes`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT id FROM todos WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  const { themeIds } = req.body || {};
  if (!Array.isArray(themeIds)) return res.status(400).json({ error: 'themeIds muss ein Array sein' });

  const requestedThemeIds = [...new Set(themeIds.filter(x => typeof x === 'string'))];
  const validThemes = requestedThemeIds.length
    ? db.prepare(`SELECT id FROM themes WHERE user_id=? AND id IN (${requestedThemeIds.map(()=>'?').join(',')})`)
        .all(req.session.uid, ...requestedThemeIds)
    : [];
  const appliedThemeIds = validThemes.map(x => x.id);
  // droppedCount bündelt gelöschte UND fremde IDs - kein Auskunfts-Unterschied.
  const droppedCount = requestedThemeIds.length - appliedThemeIds.length;

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`DELETE FROM theme_links WHERE ref_type='todo' AND ref_id=?`).run(t.id);
    const ins = db.prepare('INSERT INTO theme_links(id,theme_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?)');
    for (const themeId of appliedThemeIds) ins.run(uid(), themeId, 'todo', t.id, now);
  })();
  res.json({ ok: true, appliedThemeIds, droppedCount });
});

app.delete(`${A}/todos/:id`, requireAuth, (req, res) => {
  const t = db.prepare('SELECT id FROM todos WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!t) return res.status(404).json({ error: 'Nicht gefunden' });
  db.prepare('DELETE FROM theme_links WHERE ref_type=? AND ref_id=?').run('todo', t.id);
  try { summaries.deleteForRefs(db, req.session.uid, [{ refType: 'todo', refId: t.id }]); } catch (_) { /* best effort */ }
  db.prepare('DELETE FROM todos WHERE id=?').run(t.id);
  progress.deleteForRefs(db, [{ refType: 'todo', refId: t.id }]);
  assignments.deleteForRefs(db, [{ refType: 'todo', refId: t.id }]);
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
  // Additive Archiv-Anreicherung (Arbeitspaket B2): Links auf archivierte
  // Topics bleiben enthalten (nicht herausgefiltert), bekommen aber
  // zusätzlich `archived: boolean`.
  const archivedByTopic = archivedFlagsForTopics(
    links.filter(l => l.ref_type === 'topic').map(l => l.ref_id)
  );
  const themes = ts.map(t => parseTheme(t, links));
  for (const theme of themes) {
    for (const link of theme.links) {
      if (link.refType === 'topic') link.archived = archivedByTopic.get(link.refId) === true;
    }
  }
  res.json(themes);
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
  const { ids } = req.body || {};
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
  if (refType === 'topic' && topicArchivedGuard(res, refId)) return;
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
  // Guard nur, wenn der Link tatsächlich existiert und auf ein archiviertes
  // Topic zeigt - unbekannte/fremde link-IDs bleiben idempotent (ok:true,
  // wie vor dieser Änderung), damit sich das bestehende Lösch-Verhalten
  // nicht ändert.
  const link = db.prepare('SELECT * FROM theme_links WHERE id=? AND theme_id=?').get(req.params.lid, t.id);
  if (link && link.ref_type === 'topic' && topicArchivedGuard(res, link.ref_id)) return;
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
  // Additive Progress-Anreicherung (Fortschrittsverlauf): EINE Batch-Query
  // über summaryFor() für alle geladenen Todos (kein N+1).
  const progressItems = todos.map(td => ({
    refType: 'todo', refId: td.id,
    refCreatedAt: td.created_at, refUpdatedAt: td.updated_at,
    refDone: !!td.done, refSnoozedUntil: td.snoozed_until || null,
  }));
  const progressMap = progress.summaryFor(db, req.session.uid, progressItems);
  // Additive KI-Zusammenfassungs-Anreicherung (Paket S3): EIN forRefs()-Aufruf
  // für alle geladenen Todos (kein N+1), niemals ein KI-Aufruf hier.
  const summaryItems = todos.map(td => ({ refType: 'todo', refId: td.id }));
  const summarySettings = ai.loadSettings(db, req.session.uid);
  const summaryMap = summaries.forRefs(db, req.session.uid, summaryItems, { settings: summarySettings, scheduler: summaryScheduler });
  res.json(todos.map(td => {
    const originThemeId = seen.get(td.id);
    const origin = themesById.get(originThemeId);
    return {
      ...parseTodo(td),
      originThemeId,
      originThemeTitle: originThemeId === t.id ? null : (origin ? origin.title : null),
      progress: progressMap.get(`todo:${td.id}`) ?? null,
      aiSummary: summaryMap.get(`todo:${td.id}`) || NA_SUMMARY_PAIR,
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

  // Additive Archiv-Anreicherung (Arbeitspaket B2): NICHT im FTS-MATCH
  // (siehe oben), sondern per Batch-Lookup NACH der Suche über die
  // (maximal 200) Treffer. Archivierte Treffer werden NICHT herausgefiltert
  // (weiterhin auffindbar), nur markiert - Themen-Treffer bekommen
  // zusätzlich meetingId.
  const topicIds = rows.filter(r => r.ref_type === 'topic').map(r => r.ref_id);
  const meetingRefIds = rows.filter(r => r.ref_type === 'meeting').map(r => r.ref_id);
  const topicMeetingMap = new Map();
  if (topicIds.length) {
    const placeholders = topicIds.map(() => '?').join(',');
    for (const t of db.prepare(`SELECT id, meeting_id FROM topics WHERE id IN (${placeholders})`).all(...topicIds)) {
      topicMeetingMap.set(t.id, t.meeting_id);
    }
  }
  const meetingIdsToCheck = new Set(meetingRefIds);
  for (const mid of topicMeetingMap.values()) if (mid) meetingIdsToCheck.add(mid);
  const meetingFlags = archive.archivedFlags(
    db, [...meetingIdsToCheck].map(id => ({ refType: 'meeting', refId: id }))
  );

  res.json(rows.map(r => {
    if (r.ref_type === 'meeting') {
      return { type: r.ref_type, id: r.ref_id, archived: meetingFlags.get(`meeting:${r.ref_id}`) === true };
    }
    if (r.ref_type === 'topic') {
      const meetingId = topicMeetingMap.get(r.ref_id) || null;
      return {
        type: r.ref_type, id: r.ref_id, meetingId,
        archived: meetingId ? meetingFlags.get(`meeting:${meetingId}`) === true : false,
      };
    }
    return { type: r.ref_type, id: r.ref_id, archived: false };
  }));
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

// ── Summaries: Scheduler + Router wiring (Paket S3) ──────────────────────
// `ai` wird als vollständiges ai/index.js-Modul injiziert (liefert u.a.
// loadSettings/assertActive sowie — nach Merge mit Paket S2 — summarizeProgress
// und summarizeDescription; siehe Abschlussbericht Paket S3).
summaryScheduler = summaries.createSummaryScheduler({
  db, encryptionKey, ai, now: () => new Date(), enabled: true,
});
summaries.configure({ scheduler: summaryScheduler });

// Schreibschutz für archivierte Themen (lib/archive, Paket B-Serie).
function isRefReadOnly(refType, refId) {
  return refType === 'topic' && !!archive.isTopicArchived(db, refId);
}

// `ownsRef` wird weiter unten (Stack-Layer, Paket "Erweiterung v1.1 Phase 2")
// als function-Deklaration definiert und ist dank Hoisting hier bereits nutzbar.
app.use(A, summaries.createSummaryRouter({
  db,
  requireAuth,
  ownsRef,
  isRefReadOnly,
  scheduler: summaryScheduler,
  aiSettingsLoader: ai.loadSettings,
  now: () => new Date(),
}));

function aiErr(res, e) {
  const status = e.httpStatus || 500;
  // Sicherheits-Nachbesserung: nur bei kontrollierten Anwendungsfehlern
  // (< 500, bewusst per httpErr() in ai/index.js bzw. den Providern mit
  // festem, deutschem Klartext erzeugt) wird e.message an den Client
  // durchgereicht. Bei >= 500 (Provider-Timeout oder ungefilterter
  // Passthrough eines rohen SDK-Fehlers, siehe ai/providers/*.js) kann
  // e.message interne Details (Endpoints, Request-IDs, SDK-Fehlertexte)
  // enthalten - diese werden serverseitig geloggt statt an den Client
  // weitergegeben.
  const trusted = status < 500;
  if (!trusted) console.error('[ai]', e && e.stack ? e.stack : e);
  const body = { error: (trusted && e.message) || 'KI-Anfrage fehlgeschlagen' };
  if (e.code)   body.code   = e.code;
  if (trusted && e.detail) body.detail = e.detail;
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

// Liefert den für ein Vorhaben (refType/refId) relevantesten Stack-Frame:
// bevorzugt den aktuell offenen Frame, sonst den zuletzt gepoppten. Wird als
// getLatestFrameId-Callback an createProgressRouter() injiziert (S2-Wiring).
// Kein eigener Owner-Check nötig: der Router ruft dies erst NACH resolveRef()
// (ownsRef bereits geprüft) auf.
function getLatestFrameId(refType, refId) {
  const open = db.prepare(
    'SELECT id FROM stack_frames WHERE ref_type=? AND ref_id=? AND popped_at IS NULL LIMIT 1'
  ).get(refType, refId);
  if (open) return open.id;
  const lastPopped = db.prepare(
    'SELECT id FROM stack_frames WHERE ref_type=? AND ref_id=? AND popped_at IS NOT NULL ORDER BY popped_at DESC LIMIT 1'
  ).get(refType, refId);
  return lastPopped ? lastPopped.id : null;
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
  // Additive Archiv-Anreicherung (Arbeitspaket B2): jeder Frame bekommt
  // zusätzlich `archived: boolean` - true, wenn das referenzierte Topic zu
  // einem archivierten Meeting gehört. Todo-Frames sind nie archivierbar.
  const frames = ordered.map(f => ({
    ...frameToJson(f),
    archived: f.ref_type === 'topic' && archive.isTopicArchived(db, f.ref_id),
  }));
  res.json({ frames, depth: ordered.length });
});

app.post(`${A}/stack/push`, requireAuth, (req, res) => {
  const { refType, refId, nextStepNote } = req.body || {};
  if (!refType || !refId)                  return res.status(400).json({ error: 'refType und refId erforderlich' });
  if (!['topic','todo'].includes(refType)) return res.status(400).json({ error: 'Ungültiger refType' });
  const note = String(nextStepNote || '').trim();
  if (!note)                  return res.status(400).json({ error: 'next_step_note erforderlich' });
  if (note.length > MAX_NOTE) return res.status(400).json({ error: 'next_step_note zu lang (max 1000)' });

  if (!ownsRef(req.session.uid, refType, refId)) return res.status(404).json({ error: 'Referenz nicht gefunden' });
  if (refType === 'topic' && topicArchivedGuard(res, refId)) return;

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
  const pushedAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO stack_frames(id,user_id,ref_type,ref_id,next_step_note,pushed_at,parent_frame_id) VALUES (?,?,?,?,?,?,?)'
  ).run(id, req.session.uid, refType, refId, note, pushedAt, parentId);

  // Story 5: "Nächster Schritt" im Zielbild/Fortschrittsverlauf spiegelt die
  // Stack-Notiz (progress_meta ist die persistente Quelle, die auch nach dem
  // Pop erhalten bleibt — siehe pop-Handler unten).
  progress.setNextStep(db, req.session.uid, refType, refId, note, pushedAt);

  const frame = db.prepare('SELECT * FROM stack_frames WHERE id=?').get(id);
  const newDepth = ordered.length + 1;
  res.status(201).json({
    frame: frameToJson(frame),
    depth: newDepth,
    depth_warning: newDepth >= 4,
  });
});

// Resolution 'resumed': der Frame bleibt offen und wird an die Spitze des
// offenen Stacks befördert (kein Topic/Todo wird mutiert).
//
// Pre-state: someChain → oldTop → ... → f → ... → bottom
// Post-state: f → oldTop → ... (f's alter Platz wird geschlossen, indem sein
// Kind umgehängt wird).
function resumeFrame(db, userId, f) {
  // 1) Aktuelle Spitze anhand der unveränderten Kette bestimmen.
  const allOpen = db.prepare(
    'SELECT * FROM stack_frames WHERE user_id=? AND popped_at IS NULL'
  ).all(userId);
  const ordered = orderActiveFirst(allOpen);
  const oldTopId = ordered[0]?.id || null;

  if (oldTopId !== f.id) {
    // 2) Umhängen: wer f als parent hatte, übernimmt f's alten parent (f wird ausgeschnitten).
    db.prepare('UPDATE stack_frames SET parent_frame_id=? WHERE user_id=? AND popped_at IS NULL AND parent_frame_id=?')
      .run(f.parent_frame_id, userId, f.id);
    // 3) f wird die neue Spitze — sein parent ist die alte Spitze.
    db.prepare('UPDATE stack_frames SET parent_frame_id=? WHERE id=?').run(oldTopId, f.id);
  }

  return db.prepare('SELECT * FROM stack_frames WHERE id=?').get(f.id);
}

// Resolution 'done': markiert das referenzierte Topic/Todo als erledigt und
// übernimmt optional ein Ergebnis. Liefert die `applied`-Teilmenge, die der
// Pop-Handler unverändert in seine Response übernimmt.
function applyDoneResolution(db, userId, f, { result, resultDate }) {
  const applied = {};
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
           f.ref_id, userId);
    applied.todoDone = upd.changes === 1;
    if (result != null) applied.resultSaved = true;
  }
  return applied;
}

// Resolution 'snoozed': verschiebt das referenzierte Topic/Todo auf ein
// Schlafen-bis-Datum. Liefert die `applied`-Teilmenge.
function applySnoozedResolution(db, userId, f, { snoozedUntil }) {
  const applied = {};
  const until = snoozedUntil || defaultSnoozeUntilTomorrow();
  if (f.ref_type === 'topic') {
    const upd = db.prepare('UPDATE topics SET snoozed_until=? WHERE id=?').run(until, f.ref_id);
    if (upd.changes === 1) applied.snoozedUntil = until;
  } else if (f.ref_type === 'todo') {
    const upd = db.prepare('UPDATE todos SET snoozed_until=? WHERE id=? AND user_id=?').run(until, f.ref_id, userId);
    if (upd.changes === 1) applied.snoozedUntil = until;
  }
  return applied;
}

app.post(`${A}/stack/pop/:frameId`, requireAuth, (req, res) => {
  const { resolution, result, resultDate, snoozedUntil } = req.body || {};
  if (!VALID_RESOLUTIONS.has(resolution)) return res.status(400).json({ error: 'Ungültige resolution' });

  const f = db.prepare(
    'SELECT * FROM stack_frames WHERE id=? AND user_id=? AND popped_at IS NULL'
  ).get(req.params.frameId, req.session.uid);
  if (!f) return res.status(404).json({ error: 'Frame nicht gefunden oder bereits geschlossen' });

  // Archiv-Schreibschutz (Arbeitspaket B2): 'done'/'snoozed' mutieren das
  // referenzierte Topic (done=1 bzw. snoozed_until) - bei archiviertem
  // Meeting daher 409. 'dropped'/'resumed' mutieren das Topic NICHT und
  // bleiben erlaubt, sonst bliebe der Frame bei einem archivierten Meeting
  // dauerhaft offen im Stack hängen.
  if ((resolution === 'done' || resolution === 'snoozed') && f.ref_type === 'topic' && topicArchivedGuard(res, f.ref_id)) {
    return;
  }

  if (resolution === 'resumed') {
    const updated = resumeFrame(db, req.session.uid, f);
    return res.json({
      frame: frameToJson(updated),
      next_active: frameToJson(updated),
      applied: {},
      drift_warning: false,
    });
  }

  const now = new Date().toISOString();
  // Apply side effects on referenced topic/todo ('dropped': no side effect).
  const applied = resolution === 'done'    ? applyDoneResolution(db, req.session.uid, f, { result, resultDate })
                 : resolution === 'snoozed' ? applySnoozedResolution(db, req.session.uid, f, { snoozedUntil })
                 : {};

  // Close the frame
  db.prepare('UPDATE stack_frames SET popped_at=?, pop_resolution=? WHERE id=?').run(now, resolution, f.id);

  // Story 5: bei resolution='done' einen Zeitstrahl-Marker im Fortschrittsverlauf
  // anlegen (kind='result'). progress_meta.next_step bleibt beim Pop UNVERÄNDERT
  // (kein Löschen/Zurücksetzen) — nur dieser optionale Marker ist neu.
  // Best-effort: darf den Pop selbst NIEMALS scheitern lassen (z.B. wenn wegen
  // idx_progress_result_frame bereits ein Ergebnis-Eintrag für diesen Frame
  // existiert — dann bewusst ein No-Op statt Fehler).
  // Nur anlegen, wenn in DIESEM Pop tatsächlich ein Ergebnis übergeben wurde
  // (applied.resultSaved) — sonst würde bei "Erledigt" ohne neues Ergebnis
  // ein scheinbar frischer Zeitstrahl-Eintrag mit dem alten, unveränderten
  // Ergebnistext und dem aktuellen Pop-Zeitstempel entstehen (Tester-Fund,
  // irreführend datiert).
  if (resolution === 'done' && applied.resultSaved) {
    try {
      progress.insertEntry(db, {
        userId: req.session.uid,
        refType: f.ref_type,
        refId: f.ref_id,
        kind: 'result',
        source: 'pop_done',
        bodyHtml: '',
        bodyText: '',
        linkFrameId: f.id,
        clientToken: null,
        nowIso: now,
      });
    } catch (_) {
      // Best-effort — Fehler hier dürfen den Pop nicht kippen.
    }
  }

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

  const f = db.prepare(
    'SELECT * FROM stack_frames WHERE id=? AND user_id=? AND popped_at IS NULL'
  ).get(req.params.frameId, req.session.uid);
  if (!f) return res.status(404).json({ error: 'Frame nicht gefunden oder bereits geschlossen' });

  // Archiv-Schreibschutz (Arbeitspaket B2, Security-Review-Nachbesserung):
  // Die Notiz mutiert sowohl stack_frames.next_step_note als auch
  // progress_meta.next_step des referenzierten Topics - bei archiviertem
  // Meeting daher 409, analog zum Guard in POST /stack/pop/:frameId.
  if (f.ref_type === 'topic' && topicArchivedGuard(res, f.ref_id)) return;

  db.prepare(
    'UPDATE stack_frames SET next_step_note=? WHERE id=? AND user_id=? AND popped_at IS NULL'
  ).run(note, req.params.frameId, req.session.uid);

  // Story 5: Notiz-Update spiegelt sich in progress_meta.next_step für das
  // Vorhaben dieses Frames zurück.
  progress.setNextStep(db, req.session.uid, f.ref_type, f.ref_id, note, new Date().toISOString());

  res.json({ ok: true });
});

function defaultSnoozeUntilTomorrow() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
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
    if (refType === 'topic' && topicArchivedGuard(res, refId)) return;

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

// Download
// Security-Fund (im Rahmen von Paket B2 entdeckt, nicht durch B2 verursacht):
// Diese Route MUSS VOR der generischen List-Route (`/attachments/:refType/:refId`)
// registriert werden - sonst matcht Express `/attachments/download/:id` fälschlich
// gegen `:refType='download'` und die List-Route liefert immer 400 "Ungültiger
// Typ" statt die Datei auszuliefern (Download war dadurch nie erreichbar).
// Reine Registrierungsreihenfolge, keine Verhaltensänderung für gültige
// ALLOWED_REF_TYPES-Werte ('topic'/'todo'/'knowledge_page' matchen "download"
// als Literal-Segment ohnehin nicht).
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

// List
app.get(`${A}/attachments/:refType/:refId`, requireAuth, (req, res) => {
  const { refType, refId } = req.params;
  if (!ALLOWED_REF_TYPES.has(refType)) return res.status(400).json({ error: 'Ungültiger Typ' });
  if (!checkAttachmentOwnership(refType, refId, req.session.uid))
    return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(db.prepare('SELECT * FROM attachments WHERE ref_type=? AND ref_id=? ORDER BY created_at').all(refType, refId).map(parseAttachment));
});

// Delete
app.delete(`${A}/attachments/:id`, requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').get(req.params.id, req.session.uid);
  if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
  if (a.ref_type === 'topic' && topicArchivedGuard(res, a.ref_id)) return;
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
// *-dev.html sind Entwickler-Harnesses (Mock-Backend, keine Secrets) und sollen
// nicht im Produktionsauslieferungspfad erreichbar sein (Security Review, Niedrig: F6).
const assetsGuard = (req, res, next) => (/-dev\.html$/i.test(req.path)) ? res.status(404).end() : next();
const assetsStatic = express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'ignore', etag: true, maxAge: 0 });
app.use('/assets', assetsGuard, assetsStatic);
if (BASE) app.use(`${BASE}/assets`, assetsGuard, assetsStatic);

// ── Frontend ─────────────────────────────────────────────────
app.get(BASE || '/', (req, res) => {
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // Graph-/Progress-/Contacts-/App-Assets sind im Quelltext auf "/assets/..."
  // verlinkt (funktioniert direkt gegen den Node-Prozess). Hinter einem
  // Reverse-Proxy, der nur BASE_PATH an die App weiterleitet (siehe
  // deploy.sh-Beispielkonfiguration), muss der ausgelieferte Pfad das
  // BASE-Präfix tragen, sonst laden /assets/graph.js/.css, progress.js/.css,
  // contacts.js/.css und app.js nie.
  if (BASE) {
    html = html
      .replace('href="/assets/graph.css"', `href="${BASE}/assets/graph.css"`)
      .replace('src="/assets/graph.js"', `src="${BASE}/assets/graph.js"`)
      .replace('href="/assets/progress.css"', `href="${BASE}/assets/progress.css"`)
      .replace('src="/assets/progress.js"', `src="${BASE}/assets/progress.js"`)
      .replace('href="/assets/contacts.css"', `href="${BASE}/assets/contacts.css"`)
      .replace('src="/assets/contacts.js"', `src="${BASE}/assets/contacts.js"`)
      .replace('href="/assets/momentum.css"', `href="${BASE}/assets/momentum.css"`)
      .replace('src="/assets/momentum.js"', `src="${BASE}/assets/momentum.js"`)
      .replace('href="/assets/backup.css"', `href="${BASE}/assets/backup.css"`)
      .replace('src="/assets/backup.js"', `src="${BASE}/assets/backup.js"`)
      .replace('src="/assets/app.js"', `src="${BASE}/assets/app.js"`);
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

// ── Progress-API (Zielbild/Fortschrittsverlauf, Arbeitspaket S1/S2) ──
// Mount-Pfad folgt der App-weiten BASE_PATH-Konvention (siehe `A = BASE +
// '/api'`, analog zum Graph-/Export-Modul oben via `apiBase: A`) statt eines
// literal hartkodierten '/api/progress': in der Standard-/Test-Konfiguration
// (BASE_PATH unset/'/') ist `${A}/progress` identisch zu '/api/progress' -
// siehe Abschlussbericht für die dokumentierte Abweichung vom wörtlichen
// Vertragstext bei gesetztem BASE_PATH (Produktions-Default '/notes').
app.use(`${A}/progress`, progress.createProgressRouter({
  db,
  requireAuth,
  ownsRef,
  getLatestFrameId,
  isRefReadOnly,
  now: () => new Date(),
  // Paket S3: löst die ereignisgetriebene KI-Fortschritts-Zusammenfassung aus,
  // synchron/wurffrei, niemals awaited (siehe lib/summaries/service.js).
  onProgressEntriesChanged: summaries.onProgressEntriesChanged,
}));

// ── Sync-API (Offline-Modus, Paket P1): GET ${A}/sync/capabilities ──
app.use(`${A}/sync`, clientIdem.createSyncRouter({ requireAuth }));

// ── Archiv-API (Meetings archivieren statt löschen, Arbeitspaket B1/B2) ──
// Mount-Pfad folgt derselben App-weiten BASE_PATH-Konvention wie das
// Progress-Modul oben (`${A}/archive`, siehe Kommentar dort).
app.use(`${A}/archive`, archive.createArchiveRouter({
  db,
  requireAuth,
  uid: (req) => req.session.uid,
  parseMeeting,
  parseTopic,
  progress,
  fail,
  buildFtsQuery: buildFts5Query,
  uploadsDir: UPLOADS_DIR,
  now: () => new Date(),
}));

// ── Contacts-API (Ansprechpartner, Arbeitspaket B1/B4) ──────────
// Router definiert seine Pfade bereits relativ inkl. Präfix (z.B.
// '/contacts', '/contact-categories'), daher Mount direkt unter der
// App-weiten API-Basis `A` (nicht `${A}/contacts`) - identisch zum
// Vertragstext des Architekten.
app.use(A, contacts.createContactsRouter({
  db,
  requireAuth,
  now: () => new Date(),
  onContactDeleted: (_userId, contactId) => {
    // Räumt Zwischenstände/Notizen (progress_entries, ref_type='contact') auf.
    // Zwingend nötig: progress_entries hat KEINEN FK auf contacts, da ref_id
    // dort polymorph ist (kein DB-seitiges Cascade möglich).
    // Beide Aufräum-Schritte werden EINZELN abgesichert, damit ein Fehler im
    // einen Schritt den anderen nicht verhindert (Aufrufer in
    // lib/contacts/routes.js verschluckt Exceptions aus diesem Hook
    // vollständig, ohne selbst zu loggen). Es werden nur Fehlermeldung und
    // IDs geloggt, keine Kontaktinhalte.
    try {
      progress.deleteForRefs(db, [{ refType: 'contact', refId: contactId }]);
    } catch (e) {
      console.error('[contacts] progress cleanup failed:', e.message || e);
    }
    // Reine Zusatzabsicherung (Defense-in-Depth): contact_assignments hat
    // bereits `contact_id ... ON DELETE CASCADE` (siehe
    // lib/contacts/assignments/schema.js) und `foreign_keys = ON` ist gesetzt
    // (siehe oben), d.h. ein DELETE FROM contacts räumt contact_assignments
    // bereits über die Datenbank auf. Dieser Aufruf ist damit funktional
    // redundant, aber idempotent und schützt zusätzlich für den Fall, dass
    // das foreign_keys-Pragma einmal deaktiviert wäre.
    try {
      assignments.deleteForContact(db, contactId);
    } catch (e) {
      console.error('[contacts] assignment cleanup failed:', e.message || e);
    }
  },
}));

// ── Kontakt-Zuständigkeiten-API (Arbeitspaket B3/B4) ────────────
// Ebenfalls relative Pfade ('/assignments/:refType/:refId', '/contacts/:id/
// assignments'), daher direkt unter `A` gemountet (siehe Kommentar oben).
// `fail` wird injiziert, damit der Fehler-Envelope konsistent mit dem Rest
// der App bleibt (statt des modul-eigenen Fallbacks).
//
// ACHTUNG: `assignments` erwartet einen ISO-String statt eines Date -
// abweichend vom übrigen `now`-Muster (progress/archive/summaries erhalten
// `() => new Date()`). Sollte in lib/contacts/assignments/queries.js durch
// Nutzung von toIso() (siehe lib/contacts/queries.js) harmonisiert werden.
app.use(A, assignments.createAssignmentsRouter({
  db,
  requireAuth,
  ownsRef,
  isRefReadOnly,
  now: () => new Date().toISOString(),
  fail,
}));

// ── Momentum-API (Sichtbarer Fortschritt, Arbeitspaket M1/M2) ────
// Mount-Pfad folgt derselben App-weiten BASE_PATH-Konvention wie Progress-/
// Archiv-Modul oben (`${A}/momentum`).
app.use(`${A}/momentum`, momentum.createMomentumRouter({
  db,
  requireAuth,
  uid: (req) => req.session.uid,
  now: () => new Date(),
}));

// ── Backup-API (DB-Sicherung/Wiederherstellung, Admin, Web-only, B1/B2) ──
// Mount-Pfad folgt derselben App-weiten BASE_PATH-Konvention wie die
// übrigen Module oben (`${A}/backup`).
app.use(`${A}/backup`, backup.createBackupRouter({
  db,
  requireAdmin,
  backupsDir: BACKUPS_DIR,
  sessionStore,
  rebuildSearchIndex,
  now: () => new Date(),
}));

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
  // L-4: abgelaufene Client-Tokens taeglich bereinigen (zusaetzlich zum Purge beim Start).
  const tokenPurge = setInterval(() => {
    try { clientIdem.purgeExpiredClientTokens(db); } catch (e) {
      console.error('[client-idempotency] purge failed:', e.message || e);
    }
  }, 24 * 60 * 60 * 1000);
  if (tokenPurge.unref) tokenPurge.unref();
  // Arbeitspaket B2: schlanker In-Prozess-Scheduler für automatische Backups
  // (Muster wie ai/jobs.js oben) - läuft nur im echten Serverprozess, nicht
  // in Tests (die server.js per require() ohne require.main===module laden).
  try {
    backup.startScheduler({ db, backupsDir: BACKUPS_DIR });
  } catch (e) {
    console.error('[backup/scheduler] start failed:', e.message || e);
  }
}

if (require.main === module) app.listen(PORT, () => {
  console.log(`✓ Server läuft auf Port ${PORT}`);
  console.log(`✓ Erreichbar unter: http://localhost:${PORT}${BASE || '/'}`);
});
