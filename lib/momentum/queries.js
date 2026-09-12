'use strict';
// Datenzugriffs-/Berechnungsschicht für "Sichtbarer Fortschritt" (M1).
// Reine Funktionen auf `db` - kein Express, kein Import aus server.js.

const MAX_PAUSE_DAYS_AHEAD = 90; // vom Menschen festgelegter Planungshorizont (Requirements-Freigabe)
const MAX_PAUSE_DAYS_BEHIND = 3650; // 10 Jahre, verhindert unbegrenztes Wachstum rückwärts
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) { return String(n).padStart(2, '0'); }

function ymd(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Wandelt einen absoluten Zeitpunkt (Date oder ISO-String) unter Anwendung
// eines Client-UTC-Offsets (Minuten, z.B. `-date.getTimezoneOffset()` im
// Web oder `TimeZone.current.secondsFromGMT()/60` auf iOS) in das lokale
// Kalenderdatum "YYYY-MM-DD" um. Die Zeitzone wird bewusst NICHT serverseitig
// gespeichert (Reisen/Zeitzonenwechsel), sondern bei jeder Anfrage frisch vom
// Client übermittelt - siehe Architektur-Vertrag.
function localDateStr(dateOrIso, utcOffsetMinutes) {
  const date = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60000);
  return ymd(shifted);
}

// Wie localDateStr(), aber gibt null zurück, wenn kein Zeitstempel vorliegt
// (leerer String = "nicht gesetzt", Konvention der bestehenden *_at-Spalten).
function localDateStrFromIso(iso, utcOffsetMinutes) {
  if (!iso) return null;
  return localDateStr(iso, utcOffsetMinutes);
}

function addDaysToDateStr(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return ymd(dt);
}

function compareDateStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Montag-Sonntag-Wochenfenster (ISO-Woche) für das lokale Kalenderdatum.
function weekBoundsForLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const isoDow = (dt.getUTCDay() + 6) % 7; // Montag=0 .. Sonntag=6
  const startDate = addDaysToDateStr(dateStr, -isoDow);
  const endDate = addDaysToDateStr(startDate, 6);
  return { startDate, endDate };
}

function isValidDateStr(raw) {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) return false;
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── Einstellungen ────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  completionToastEnabled: true,
  streakEnabled: true,
  weeklyReviewEnabled: true,
};

function rowToSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    completionToastEnabled: !!row.completion_toast_enabled,
    streakEnabled: !!row.streak_enabled,
    weeklyReviewEnabled: !!row.weekly_review_enabled,
  };
}

function getSettings(db, userId) {
  const row = db.prepare('SELECT * FROM momentum_settings WHERE user_id=?').get(userId);
  return rowToSettings(row);
}

// Partielles Patch-Update; unbekannte/undefined Felder bleiben unverändert.
// Legt bei Erstzugriff eine Zeile mit den Defaults an (Upsert).
function saveSettings(db, userId, patch, nowIso) {
  const current = getSettings(db, userId);
  const next = {
    completionToastEnabled: patch.completionToastEnabled !== undefined ? !!patch.completionToastEnabled : current.completionToastEnabled,
    streakEnabled: patch.streakEnabled !== undefined ? !!patch.streakEnabled : current.streakEnabled,
    weeklyReviewEnabled: patch.weeklyReviewEnabled !== undefined ? !!patch.weeklyReviewEnabled : current.weeklyReviewEnabled,
  };
  db.prepare(`
    INSERT INTO momentum_settings(user_id, completion_toast_enabled, streak_enabled, weekly_review_enabled, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      completion_toast_enabled=excluded.completion_toast_enabled,
      streak_enabled=excluded.streak_enabled,
      weekly_review_enabled=excluded.weekly_review_enabled,
      updated_at=excluded.updated_at
  `).run(userId, next.completionToastEnabled ? 1 : 0, next.streakEnabled ? 1 : 0, next.weeklyReviewEnabled ? 1 : 0, nowIso);
  return next;
}

// ── Pausentage ───────────────────────────────────────────────
function listPauseDays(db, userId) {
  return db.prepare('SELECT pause_date FROM momentum_pause_days WHERE user_id=? ORDER BY pause_date')
    .all(userId).map((r) => r.pause_date);
}

const PAUSE_DAY_ERRORS = {
  INVALID_DATE: 'INVALID_DATE',
  TOO_FAR_AHEAD: 'TOO_FAR_AHEAD',
  TOO_FAR_BEHIND: 'TOO_FAR_BEHIND',
};

// Validiert und legt einen Pausentag an (idempotent - doppeltes Anlegen ist
// kein Fehler). `todayStr` ist das lokale Datum des Aufrufers (Referenz für
// die Vorlauf-Obergrenze), damit die Prüfung nicht von der Serverzeitzone
// abhängt.
function addPauseDay(db, userId, dateStr, todayStr, nowIso) {
  if (!isValidDateStr(dateStr)) return { ok: false, error: PAUSE_DAY_ERRORS.INVALID_DATE };
  if (compareDateStr(dateStr, addDaysToDateStr(todayStr, MAX_PAUSE_DAYS_AHEAD)) > 0) {
    return { ok: false, error: PAUSE_DAY_ERRORS.TOO_FAR_AHEAD };
  }
  if (compareDateStr(dateStr, addDaysToDateStr(todayStr, -MAX_PAUSE_DAYS_BEHIND)) < 0) {
    return { ok: false, error: PAUSE_DAY_ERRORS.TOO_FAR_BEHIND };
  }
  db.prepare('INSERT OR IGNORE INTO momentum_pause_days(user_id, pause_date, created_at) VALUES (?,?,?)')
    .run(userId, dateStr, nowIso);
  return { ok: true, date: dateStr };
}

function removePauseDay(db, userId, dateStr) {
  if (!isValidDateStr(dateStr)) return { ok: false, error: PAUSE_DAY_ERRORS.INVALID_DATE };
  const res = db.prepare('DELETE FROM momentum_pause_days WHERE user_id=? AND pause_date=?').run(userId, dateStr);
  return { ok: true, removed: res.changes > 0 };
}

// ── Aktive Tage / Serie ──────────────────────────────────────
// Sammelt alle lokalen Kalendertage, an denen der Nutzer mindestens ein
// Todo/Thema angelegt ODER abgeschlossen hat. `topics` besitzt kein eigenes
// user_id - Eigentümerschaft läuft über das zugehörige Meeting (siehe
// .claude/agent-memory/requirements-engineer/domain_progress_mechanik.md).
function activeLocalDatesForUser(db, userId, utcOffsetMinutes) {
  const rows = db.prepare(`
    SELECT created_at AS ts FROM todos WHERE user_id=?
    UNION ALL
    SELECT completed_at AS ts FROM todos WHERE user_id=? AND completed_at != ''
    UNION ALL
    SELECT tp.created_at AS ts FROM topics tp JOIN meetings m ON m.id = tp.meeting_id WHERE m.user_id=?
    UNION ALL
    SELECT tp.completed_at AS ts FROM topics tp JOIN meetings m ON m.id = tp.meeting_id WHERE m.user_id=? AND tp.completed_at != ''
  `).all(userId, userId, userId, userId);
  const set = new Set();
  for (const r of rows) {
    if (!r.ts) continue;
    set.add(localDateStr(r.ts, utcOffsetMinutes));
  }
  return set;
}

// Serie = aufeinanderfolgende aktive (oder als Pause markierte) Kalendertage,
// rückwärts von heute gezählt. Der heutige Tag zählt erst mit, sobald er
// selbst aktiv ist - ist er es (noch) nicht, wird er weder mitgezählt noch
// bricht er die Serie schon ab (siehe Akzeptanzkriterien Story 5).
function computeStreak(db, userId, utcOffsetMinutes, now) {
  const todayStr = localDateStr(now, utcOffsetMinutes);
  const activeDates = activeLocalDatesForUser(db, userId, utcOffsetMinutes);
  const pauseDates = new Set(listPauseDays(db, userId));
  const activeToday = activeDates.has(todayStr);
  let cursor = activeToday || pauseDates.has(todayStr) ? todayStr : addDaysToDateStr(todayStr, -1);
  let current = 0;
  while (activeDates.has(cursor) || pauseDates.has(cursor)) {
    current += 1;
    cursor = addDaysToDateStr(cursor, -1);
  }
  return { current, activeToday };
}

// ── Wochen-Rückblick ─────────────────────────────────────────
function weekCounts(db, userId, startDate, endDate) {
  const createdCount = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM todos WHERE user_id=? AND substr(created_at,1,10) BETWEEN ? AND ?) +
      (SELECT COUNT(*) FROM topics tp JOIN meetings m ON m.id=tp.meeting_id WHERE m.user_id=? AND substr(tp.created_at,1,10) BETWEEN ? AND ?) AS c
  `).get(userId, startDate, endDate, userId, startDate, endDate).c;
  // Hinweis: `substr(created_at,1,10)` vergleicht das UTC-Datum, nicht das
  // lokale - für die grobe Wochenzuordnung ausreichend genau (Abweichung nur
  // in Zeitzonen-Randstunden). Für den exakten "aktiver Tag"/Streak-Fall wird
  // stattdessen computeStreak()/activeLocalDatesForUser() mit echtem
  // Client-Offset verwendet.
  const completedCount = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM todos WHERE user_id=? AND completed_at != '' AND substr(completed_at,1,10) BETWEEN ? AND ?) +
      (SELECT COUNT(*) FROM topics tp JOIN meetings m ON m.id=tp.meeting_id WHERE m.user_id=? AND tp.completed_at != '' AND substr(tp.completed_at,1,10) BETWEEN ? AND ?) AS c
  `).get(userId, startDate, endDate, userId, startDate, endDate).c;
  return { createdCount, completedCount };
}

function weekMilestones(db, userId, startDate, endDate) {
  return db.prepare(`
    SELECT kind, ref_id AS refId, name, occurred_at AS occurredAt
    FROM momentum_milestones
    WHERE user_id=? AND substr(occurred_at,1,10) BETWEEN ? AND ?
    ORDER BY occurred_at ASC
  `).all(userId, startDate, endDate);
}

module.exports = {
  DEFAULT_SETTINGS,
  PAUSE_DAY_ERRORS,
  MAX_PAUSE_DAYS_AHEAD,
  MAX_PAUSE_DAYS_BEHIND,
  localDateStr,
  localDateStrFromIso,
  addDaysToDateStr,
  weekBoundsForLocalDate,
  isValidDateStr,
  getSettings,
  saveSettings,
  listPauseDays,
  addPauseDay,
  removePauseDay,
  activeLocalDatesForUser,
  computeStreak,
  weekCounts,
  weekMilestones,
};
