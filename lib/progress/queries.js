'use strict';
// Datenzugriffsschicht für den Fortschrittsverlauf (Arbeitspaket S1).
//
// Ausschließlich parametrisierte Statements (`db.prepare(...)` mit
// `?`-Platzhaltern). IN(...)-Listen werden über generierte `?`-Platzhalter
// gebaut, NIEMALS über String-Konkatenation von IDs.
const crypto = require('crypto');
const { sanitizePlainField, progressPlainText } = require('./sanitize');
const { placeholders: placeholdersFor } = require('../http');

const DORMANT_DAYS = 7;
const STALE_DAYS = 14;
const GAP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

function daysSince(iso, nowMs) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / DAY_MS);
}

// Absoluter Tagesabstand zwischen zwei ISO-Zeitstempeln (unabhängig von
// Reihenfolge). Liefert 0, wenn einer der beiden nicht parsebar ist.
function daysBetween(isoA, isoB) {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(a - b) / DAY_MS;
}

function snoozedInFuture(snoozedUntil, nowMs) {
  if (!snoozedUntil) return false;
  const t = new Date(snoozedUntil).getTime();
  if (Number.isNaN(t)) return false;
  return t > nowMs;
}

function maxIso(values) {
  const present = values.filter(Boolean);
  if (!present.length) return null;
  return present.reduce((a, b) => (a > b ? a : b));
}

// Grobe, deutsche Näherung für die Dormancy-Anzeige ("3 Wochen").
function roughGermanDuration(daysRaw) {
  const d = Math.floor(daysRaw);
  if (d < 1) return 'weniger als 1 Tag';
  if (d === 1) return '1 Tag';
  if (d < 14) return `${d} Tage`;
  const weeks = Math.round(d / 7);
  if (weeks < 8) return weeks === 1 ? '1 Woche' : `${weeks} Wochen`;
  const months = Math.round(d / 30);
  return months <= 1 ? '1 Monat' : `${months} Monaten`;
}

function formatRelativeDaysDe(daysRaw) {
  const d = Math.floor(daysRaw == null ? 0 : daysRaw);
  if (d <= 0) return 'heute';
  if (d === 1) return 'vor 1 Tag';
  return `vor ${d} Tagen`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'todo'|'topic'|'contact'} refType
 * @param {string} refId
 */
function refInfo(db, refType, refId) {
  let row;
  if (refType === 'todo') {
    row = db.prepare(
      'SELECT title, description, done, snoozed_until, created_at, result, result_date, updated_at FROM todos WHERE id=?'
    ).get(refId);
  } else if (refType === 'topic') {
    row = db.prepare(
      'SELECT title, description, done, snoozed_until, created_at, result, result_date, updated_at FROM topics WHERE id=?'
    ).get(refId);
  } else if (refType === 'contact') {
    // Arbeitspaket B2 (Ansprechpartner-Notizen): Kontakte sind kein Vorhaben -
    // kein Erledigt-/Schlummer-/Ergebnis-Zustand. `description` liefert laut
    // Vertrag bewusst '' (nicht `contacts.description`), da die Kontakt-
    // Beschreibung fachlich nicht Teil des Fortschrittsverlauf-Leerzustands ist.
    row = db.prepare('SELECT name, created_at, updated_at FROM contacts WHERE id=?').get(refId);
    if (!row) return { exists: false };
    return {
      exists: true,
      title: row.name,
      description: '',
      done: false,
      snoozedUntil: null,
      createdAt: row.created_at,
      result: '',
      resultDate: '',
      updatedAt: row.updated_at || null,
    };
  } else {
    return { exists: false };
  }
  if (!row) return { exists: false };
  return {
    exists: true,
    title: row.title,
    description: row.description || '',
    done: !!row.done,
    snoozedUntil: row.snoozed_until ? row.snoozed_until : null,
    createdAt: row.created_at,
    result: row.result || '',
    resultDate: row.result_date || '',
    updatedAt: row.updated_at || null,
  };
}

// Redesign "Übersichtlichere Todos und Tasks": das Zielbild (`goal`) entfällt
// - das Ziel ergibt sich aus der Beschreibung. `getMeta`/`setNextStep` liefern
// bzw. schreiben deshalb nur noch `next_step`.
function getMeta(db, refType, refId) {
  const row = db.prepare(
    'SELECT next_step, next_step_updated_at FROM progress_meta WHERE ref_type=? AND ref_id=?'
  ).get(refType, refId);
  if (!row) return { nextStep: '', nextStepUpdatedAt: null };
  return {
    nextStep: row.next_step || '',
    nextStepUpdatedAt: row.next_step_updated_at || null,
  };
}

function metaExists(db, refType, refId) {
  return !!db.prepare('SELECT 1 FROM progress_meta WHERE ref_type=? AND ref_id=?').get(refType, refId);
}

function setNextStep(db, userId, refType, refId, nextStep, nowIso) {
  const cleanNextStep = sanitizePlainField(nextStep);
  if (metaExists(db, refType, refId)) {
    db.prepare('UPDATE progress_meta SET next_step=?, next_step_updated_at=? WHERE ref_type=? AND ref_id=?')
      .run(cleanNextStep, nowIso, refType, refId);
  } else {
    db.prepare(
      `INSERT INTO progress_meta(ref_type, ref_id, user_id, next_step, next_step_updated_at, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(refType, refId, userId, cleanNextStep, nowIso, nowIso);
  }
  return getMeta(db, refType, refId);
}

/**
 * Idempotenz über (user_id, client_token): existiert bereits ein Eintrag mit
 * demselben Token für denselben Nutzer, wird dieser zurückgegeben statt ein
 * zweites Mal einzufügen.
 */
function insertEntry(db, {
  userId, refType, refId, kind = 'note', source = 'manual',
  bodyHtml = '', bodyText = '', linkFrameId = null, clientToken = null, nowIso,
}) {
  if (clientToken) {
    const existing = db.prepare(
      'SELECT * FROM progress_entries WHERE user_id=? AND client_token=?'
    ).get(userId, clientToken);
    if (existing) return { entry: existing, idempotent: true };
  }
  const id = genId();
  db.prepare(
    `INSERT INTO progress_entries
       (id,user_id,ref_type,ref_id,kind,source,body_html,body_text,link_frame_id,client_token,created_at,edited_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`
  ).run(id, userId, refType, refId, kind, source, bodyHtml, bodyText, linkFrameId, clientToken, nowIso);
  const entry = db.prepare('SELECT * FROM progress_entries WHERE id=?').get(id);
  return { entry, idempotent: false };
}

/**
 * Owner-Check UND kind<>'result'-Check leben im WHERE des UPDATE selbst
 * (Defense-in-Depth) - nicht nur vorgelagert geprüft.
 */
function updateEntry(db, userId, entryId, { bodyHtml, bodyText, nowIso }) {
  const r = db.prepare(
    `UPDATE progress_entries SET body_html=?, body_text=?, edited_at=?
     WHERE id=? AND user_id=? AND kind<>'result'`
  ).run(bodyHtml, bodyText, nowIso, entryId, userId);
  if (r.changes === 0) return null;
  return db.prepare('SELECT * FROM progress_entries WHERE id=?').get(entryId);
}

function deleteEntry(db, userId, entryId) {
  const r = db.prepare(
    `DELETE FROM progress_entries WHERE id=? AND user_id=? AND kind<>'result'`
  ).run(entryId, userId);
  return r.changes > 0;
}

function getEntry(db, userId, entryId) {
  return db.prepare('SELECT * FROM progress_entries WHERE id=? AND user_id=?').get(entryId, userId) || null;
}

/**
 * Cursor-Pagination über (created_at, id) DESC. Cursor-Format:
 * "<createdAtIso>|<id>". Liest intern `limit+1` Zeilen: die zusätzliche
 * Zeile dient sowohl der hasMore-Erkennung als auch der korrekten
 * gapDaysBefore-Berechnung des ältesten Eintrags der aktuellen Seite
 * (gegen den nächstälteren, nicht mit ausgelieferten Eintrag).
 */
function listEntries(db, userId, refType, refId, { limit = 20, cursor = null } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;

  let where = 'ref_type=? AND ref_id=? AND user_id=?';
  const params = [refType, refId, userId];

  const cursorParts = typeof cursor === 'string' && cursor.includes('|')
    ? (() => {
        const idx = cursor.indexOf('|');
        const createdAt = cursor.slice(0, idx);
        const id = cursor.slice(idx + 1);
        return createdAt && id ? { createdAt, id } : null;
      })()
    : null;

  if (cursorParts) {
    where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(cursorParts.createdAt, cursorParts.createdAt, cursorParts.id);
  }

  const rows = db.prepare(
    `SELECT * FROM progress_entries WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(...params, safeLimit + 1);

  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit);
  const extraRow = hasMore ? rows[safeLimit] : null;

  const entries = page.map((row, i) => {
    // "Nächstälterer" Eintrag: innerhalb der Seite der direkte Nachfolger
    // (Sortierung DESC), für den letzten Seiteneintrag die separat
    // gelesene Zusatzzeile. Fehlt beides, ist dies der allerälteste
    // Eintrag insgesamt -> gapDaysBefore = 0.
    const olderRow = i + 1 < page.length ? page[i + 1] : extraRow;
    const gapDaysBefore = olderRow ? Math.floor(daysBetween(row.created_at, olderRow.created_at)) : 0;
    return {
      ...row,
      gapDaysBefore,
      showDormancyMarker: gapDaysBefore > GAP_DAYS,
    };
  });

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null;

  return { entries, nextCursor, hasMore };
}

/**
 * Liefert für eine Liste von Refs (jeweils mit refType/refId/refCreatedAt/
 * refDone/refSnoozedUntil, optional refUpdatedAt) eine Zusammenfassung -
 * GENAU EINE GROUP-BY-Query pro refType (kein N+1).
 * @returns {Map<string, object>} key = `${refType}:${refId}`
 */
function summaryFor(db, userId, items) {
  const result = new Map();
  const nowMs = Date.now();
  const list = Array.isArray(items) ? items : [];

  // Arbeitspaket B2 (Ansprechpartner-Notizen): 'contact' generisch mitgeführt,
  // damit die bestehenden POST/PUT/DELETE-/entries-Routen (die summaryFor()
  // unabhängig vom refType aufrufen) auch für Kontakte ein `summary`-Objekt
  // statt `undefined` liefern - keine neue Abfrage-Logik, nur Allowlist-
  // Erweiterung analog zu deleteForRefs()/refInfo().
  const byType = { todo: [], topic: [], contact: [] };
  for (const it of list) {
    if (it && (it.refType === 'todo' || it.refType === 'topic' || it.refType === 'contact') && it.refId) {
      byType[it.refType].push(it);
    }
  }

  const counts = new Map();
  const nextSteps = new Map();
  for (const refType of ['todo', 'topic', 'contact']) {
    const ids = byType[refType].map((it) => it.refId);
    if (!ids.length) continue;
    const placeholders = placeholdersFor(ids.length);

    const countRows = db.prepare(
      `SELECT ref_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
       FROM progress_entries
       WHERE user_id=? AND ref_type=? AND ref_id IN (${placeholders})
       GROUP BY ref_id`
    ).all(userId, refType, ...ids);
    for (const r of countRows) counts.set(`${refType}:${r.ref_id}`, { entryCount: r.cnt, lastEntryAt: r.last_at });

    const metaRows = db.prepare(
      `SELECT ref_id, next_step FROM progress_meta WHERE user_id=? AND ref_type=? AND ref_id IN (${placeholders})`
    ).all(userId, refType, ...ids);
    for (const r of metaRows) nextSteps.set(`${refType}:${r.ref_id}`, r.next_step || '');
  }

  for (const it of list) {
    if (!it || !(it.refType === 'todo' || it.refType === 'topic' || it.refType === 'contact') || !it.refId) continue;
    const key = `${it.refType}:${it.refId}`;
    const c = counts.get(key) || { entryCount: 0, lastEntryAt: null };
    const entryCount = c.entryCount || 0;
    const lastEntryAt = c.lastEntryAt || null;

    const lastActivityAt = maxIso([lastEntryAt, it.refUpdatedAt, it.refCreatedAt]);
    const snoozedFuture = snoozedInFuture(it.refSnoozedUntil, nowMs);

    const staleDaysRaw = daysSince(lastEntryAt, nowMs);
    const stale = entryCount > 0 && staleDaysRaw != null && staleDaysRaw > STALE_DAYS;

    // Kontakte haben kein Ruhephasen-Konzept (siehe detailStats()).
    const isContact = it.refType === 'contact';
    const dormantDaysRaw = daysSince(lastActivityAt, nowMs);
    const dormant = !isContact && !it.refDone && !snoozedFuture && dormantDaysRaw != null && dormantDaysRaw > DORMANT_DAYS;
    const dormantSince = dormant ? lastActivityAt : null;

    let undocumented = false;
    if (!it.refDone && !snoozedFuture) {
      if (entryCount > 0 && staleDaysRaw != null && staleDaysRaw > STALE_DAYS) {
        undocumented = true;
      } else if (entryCount === 0 && it.refCreatedAt) {
        const createdDaysRaw = daysSince(it.refCreatedAt, nowMs);
        if (createdDaysRaw != null && createdDaysRaw > STALE_DAYS) undocumented = true;
      }
    }

    const orderKey = entryCount > 0 ? lastEntryAt : null;

    let badgeLabel = null;
    let badgeEmphasis = 'normal';
    let badgeSuffix = null;
    if (entryCount > 0) {
      badgeEmphasis = stale ? 'stale' : 'normal';
      const word = entryCount === 1 ? 'Zwischenstand' : 'Zwischenstände';
      badgeLabel = `${entryCount} ${word} · ${formatRelativeDaysDe(staleDaysRaw)}`;
      // "Stale" wird über Icon UND Text erkennbar - Farbe ist nie alleiniger
      // Bedeutungsträger (Redesign "Übersichtlichere Todos und Tasks").
      // Der Text wird EINMAL serverseitig formuliert, damit Web und App
      // identisch sind.
      badgeSuffix = stale ? 'länger nicht aktualisiert' : null;
    }

    result.set(key, {
      entryCount,
      lastEntryAt,
      stale,
      staleDays: staleDaysRaw != null ? Math.floor(staleDaysRaw) : 0,
      dormant,
      dormantSince,
      orderKey,
      undocumented,
      nextStep: nextSteps.get(key) || '',
      badgeLabel,
      badgeEmphasis,
      badgeSuffix,
    });
  }

  return result;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {'todo'|'topic'|'contact'} refType
 * @param {string} refId
 * @param {ReturnType<typeof refInfo>} ref Bereits geladene Ref-Info (siehe refInfo()).
 */
function detailStats(db, userId, refType, refId, ref) {
  const nowMs = Date.now();
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt, MIN(created_at) AS first_at, MAX(created_at) AS last_at
     FROM progress_entries WHERE user_id=? AND ref_type=? AND ref_id=?`
  ).get(userId, refType, refId);

  const entryCount = row.cnt || 0;
  const firstEntryAt = row.first_at || null;
  const lastEntryAt = row.last_at || null;

  const refDone = !!(ref && ref.done);
  const refSnoozedUntil = ref ? ref.snoozedUntil : null;
  const refCreatedAt = ref ? ref.createdAt : null;
  const refUpdatedAt = ref ? ref.updatedAt : null;

  const lastActivityAt = maxIso([lastEntryAt, refUpdatedAt, refCreatedAt]);
  const snoozedFuture = snoozedInFuture(refSnoozedUntil, nowMs);

  const staleDaysRaw = daysSince(lastEntryAt, nowMs);
  const stale = entryCount > 0 && staleDaysRaw != null && staleDaysRaw > STALE_DAYS;

  // Arbeitspaket B2 (Ansprechpartner-Notizen): Kontakte sind kein Vorhaben und
  // haben deshalb kein Ruhephasen-/Wiedereinstiegs-Konzept - dormant ist für
  // ref_type='contact' laut Vertrag immer false, unabhängig von der
  // generischen Formel unten (die für todo/topic unverändert bleibt).
  const isContact = refType === 'contact';

  const dormantDaysRaw = daysSince(lastActivityAt, nowMs);
  const dormant = !isContact && !refDone && !snoozedFuture && dormantDaysRaw != null && dormantDaysRaw > DORMANT_DAYS;

  const stats = {
    entryCount,
    firstEntryAt,
    lastEntryAt,
    lastActivityAt,
    dormant,
    dormantDays: dormantDaysRaw != null ? Math.floor(dormantDaysRaw) : 0,
    stale,
    staleDays: staleDaysRaw != null ? Math.floor(staleDaysRaw) : 0,
  };

  const meta = getMeta(db, refType, refId);
  const nextStepEmpty = !meta.nextStep || !meta.nextStep.trim();
  // Redesign "Übersichtlichere Todos und Tasks": das Zielbild entfällt als
  // Eingangsgröße - der Leerzustand wird ausschließlich aus Beschreibung,
  // "Nächster Schritt" und Zwischenständen ermittelt.
  const descriptionEmpty = !ref || !progressPlainText(ref.description || '').trim();

  const reentry = isContact
    ? {
        show: false,
        dormantSince: null,
        dormantLabel: null,
        empty: descriptionEmpty && nextStepEmpty && entryCount === 0,
        ai: { available: false, frameId: null },
      }
    : {
        show: dormant === true,
        dormantSince: dormant ? lastActivityAt : null,
        dormantLabel: dormant && dormantDaysRaw != null ? roughGermanDuration(dormantDaysRaw) : null,
        empty: descriptionEmpty && nextStepEmpty && entryCount === 0,
        // Default, solange kein Stack-Zugriff verfügbar ist (S1 hat keinen
        // direkten Zugriff auf stack_frames). routes.js weaved dies nach dem
        // Aufruf hier via des injizierten `getLatestFrameId`-Callbacks ein
        // (siehe createProgressRouter) - detailStats() bleibt dafür bewusst
        // synchron und ohne Callback-Parameter, siehe Abschlussbericht.
        ai: { available: false, frameId: null },
      };

  return { stats, reentry };
}

/**
 * Löscht alle progress_entries/progress_meta für die übergebenen Refs.
 * Nutzt generierte `?`-Platzhalter für IN(...)-Listen, niemals
 * String-Konkatenation von IDs.
 *
 * Arbeitspaket B2 (Ansprechpartner-Notizen): `ref_type='contact'` wird
 * akzeptiert, betrifft aber NUR `progress_entries` - `progress_meta` trägt
 * laut Vertrag niemals Kontakt-Zeilen (siehe schema.js).
 * @param {import('better-sqlite3').Database} db
 * @param {{refType: 'todo'|'topic'|'contact', refId: string}[]} refs
 */
function deleteForRefs(db, refs) {
  const result = { entries: 0, meta: 0 };
  const list = Array.isArray(refs)
    ? refs.filter((r) => r && (r.refType === 'todo' || r.refType === 'topic' || r.refType === 'contact') && r.refId)
    : [];
  if (!list.length) return result;

  const byType = { todo: [], topic: [], contact: [] };
  for (const r of list) byType[r.refType].push(r.refId);

  const run = db.transaction(() => {
    for (const refType of ['todo', 'topic', 'contact']) {
      const ids = byType[refType];
      if (!ids.length) continue;
      const placeholders = placeholdersFor(ids.length);
      const e = db.prepare(
        `DELETE FROM progress_entries WHERE ref_type=? AND ref_id IN (${placeholders})`
      ).run(refType, ...ids);
      result.entries += e.changes;
      if (refType === 'contact') continue;
      const m = db.prepare(
        `DELETE FROM progress_meta WHERE ref_type=? AND ref_id IN (${placeholders})`
      ).run(refType, ...ids);
      result.meta += m.changes;
    }
  });
  run();
  return result;
}

/**
 * Verschiebt Zielbild/Fortschrittsverlauf von einer Referenz auf eine
 * andere - für die bestehenden "Todo <-> Meeting-Thema"-Konvertierungs-/
 * Verschiebe-Endpunkte in server.js, die dieselbe fachliche Sache unter
 * neuer (ref_type, ref_id) fortführen (analog zum bestehenden Muster für
 * `theme_links` an denselben Stellen). Kein Löschen, keine Migration der
 * ID - der Fortschrittsverlauf des Nutzers bleibt erhalten
 * (Security Review, Mittel: F4).
 * @param {import('better-sqlite3').Database} db
 * @param {'todo'|'topic'} fromRefType
 * @param {string} fromRefId
 * @param {'todo'|'topic'} toRefType
 * @param {string} toRefId
 */
function retargetRef(db, fromRefType, fromRefId, toRefType, toRefId) {
  const run = db.transaction(() => {
    db.prepare('UPDATE progress_entries SET ref_type=?, ref_id=? WHERE ref_type=? AND ref_id=?')
      .run(toRefType, toRefId, fromRefType, fromRefId);
    db.prepare('UPDATE progress_meta SET ref_type=?, ref_id=? WHERE ref_type=? AND ref_id=?')
      .run(toRefType, toRefId, fromRefType, fromRefId);
  });
  run();
}

module.exports = {
  DORMANT_DAYS,
  STALE_DAYS,
  GAP_DAYS,
  refInfo,
  getMeta,
  setNextStep,
  insertEntry,
  updateEntry,
  deleteEntry,
  getEntry,
  listEntries,
  summaryFor,
  detailStats,
  deleteForRefs,
  retargetRef,
};
