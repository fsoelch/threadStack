'use strict';
// Datenzugriffsschicht für das Archiv-Kernmodul (Arbeitspaket B1).
//
// Ausschließlich parametrisierte Statements (`db.prepare(...)` mit
// `?`-Platzhaltern). IN(...)-Listen werden über generierte `?`-Platzhalter
// gebaut, NIEMALS über String-Konkatenation von IDs. `refType` wird
// ausschließlich gegen die Allowlist `ARCHIVABLE_REF_TYPES` geprüft, nie in
// SQL interpoliert (Ausnahme: `notArchivedSql`, siehe dortiger Kommentar -
// dort ist der Wert bereits gegen dieselbe Allowlist geprüft und niemals
// Nutzereingabe).

// Aktuell einziger archivierbarer Referenztyp. Einzige Erweiterungsstelle für
// später (Todos, Wissensseiten) - siehe Vertrag/Architekturentscheidung.
const ARCHIVABLE_REF_TYPES = new Set(['meeting']);

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL-Fragment "nicht archiviert" für ein JOIN/WHERE. `alias` ist der
 * Tabellenalias mit Spalte `id` (z.B. "m" für `... FROM meetings m WHERE
 * ${notArchivedSql('m')}`).
 *
 * `alias` und `refType` sind IMMER Code-Konstanten (vom Aufrufer literal im
 * Quelltext angegeben), NIEMALS Nutzereingaben - die Prüfung unten ist
 * Defense-in-Depth, keine Eingabevalidierung im eigentlichen Sinn. Deshalb
 * ist die direkte String-Interpolation von `alias`/`refType` in das
 * zurückgegebene SQL-Fragment hier bewusst zulässig (im Gegensatz zu jeder
 * Verwendung von `refId`, die IMMER über `?`-Platzhalter laufen muss).
 *
 * @param {string} alias
 * @param {string} [refType='meeting']
 * @returns {string}
 */
function notArchivedSql(alias, refType = 'meeting') {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    throw new TypeError(`notArchivedSql: ungültiger alias "${alias}"`);
  }
  if (!ARCHIVABLE_REF_TYPES.has(refType)) {
    throw new TypeError(`notArchivedSql: ungültiger refType "${refType}"`);
  }
  return `NOT EXISTS (SELECT 1 FROM archive_state _a WHERE _a.ref_type='${refType}' AND _a.ref_id=${alias}.id)`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refType
 * @param {string} refId
 * @returns {boolean}
 */
function isArchived(db, refType, refId) {
  return !!db.prepare('SELECT 1 FROM archive_state WHERE ref_type=? AND ref_id=?').get(refType, refId);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refType
 * @param {string} refId
 * @returns {string|null} ISO-8601 oder null, wenn nicht archiviert.
 */
function archivedAt(db, refType, refId) {
  const row = db.prepare('SELECT archived_at FROM archive_state WHERE ref_type=? AND ref_id=?').get(refType, refId);
  return row ? row.archived_at : null;
}

/**
 * Ist das Meeting, zu dem dieses Topic gehört, archiviert? (topics ->
 * meetings -> archive_state). Liefert `false`, wenn das Topic nicht
 * existiert.
 * @param {import('better-sqlite3').Database} db
 * @param {string} topicId
 * @returns {boolean}
 */
function isTopicArchived(db, topicId) {
  const row = db.prepare(`
    SELECT 1 FROM topics t
    JOIN archive_state a ON a.ref_type='meeting' AND a.ref_id = t.meeting_id
    WHERE t.id = ?
  `).get(topicId);
  return !!row;
}

/**
 * Batch-Lookup für Suche/Stack/Theme-Links; refs: [{refType,refId}]. Key-
 * Format: `${refType}:${refId}`. Kein N+1: eine `IN(...)`-Query PRO
 * distinktem refType in der Eingabeliste (nicht pro Element) - analog dem
 * Muster in `lib/progress/queries.js::summaryFor`.
 * @param {import('better-sqlite3').Database} db
 * @param {{refType: string, refId: string}[]} refs
 * @returns {Map<string, boolean>}
 */
function archivedFlags(db, refs) {
  const result = new Map();
  const list = Array.isArray(refs)
    ? refs.filter((r) => r && typeof r.refType === 'string' && typeof r.refId === 'string' && r.refId)
    : [];
  if (!list.length) return result;

  const byType = new Map();
  for (const r of list) {
    result.set(`${r.refType}:${r.refId}`, false);
    if (!byType.has(r.refType)) byType.set(r.refType, new Set());
    byType.get(r.refType).add(r.refId);
  }

  for (const [refType, idSet] of byType) {
    const ids = [...idSet];
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT ref_id FROM archive_state WHERE ref_type=? AND ref_id IN (${placeholders})`
    ).all(refType, ...ids);
    for (const row of rows) result.set(`${refType}:${row.ref_id}`, true);
  }

  return result;
}

/**
 * Idempotent. Setzt KEINE Ownership voraus - der Aufruf erfolgt erst nach
 * einer Ownership-Prüfung durch den Router.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} refType
 * @param {string} refId
 * @param {string} nowIso
 * @returns {{changed: boolean, archivedAt: string}}
 */
function archive(db, userId, refType, refId, nowIso) {
  const existing = db.prepare(
    'SELECT archived_at FROM archive_state WHERE ref_type=? AND ref_id=?'
  ).get(refType, refId);
  if (existing) {
    return { changed: false, archivedAt: existing.archived_at };
  }
  db.prepare(
    'INSERT INTO archive_state(ref_type, ref_id, user_id, archived_at) VALUES (?,?,?,?)'
  ).run(refType, refId, userId, nowIso);
  return { changed: true, archivedAt: nowIso };
}

/**
 * Idempotent. Entfernt den Archiv-Status (Wiederherstellen).
 * @param {import('better-sqlite3').Database} db
 * @param {string} refType
 * @param {string} refId
 * @returns {{changed: boolean}}
 */
function restore(db, refType, refId) {
  const r = db.prepare('DELETE FROM archive_state WHERE ref_type=? AND ref_id=?').run(refType, refId);
  return { changed: r.changes > 0 };
}

/**
 * Interner Aufräum-Helfer (z.B. innerhalb `purgeMeeting`s Transaktion) -
 * anders als `restore()` ohne Rückgabewert/Idempotenz-Signal, da der
 * Aufrufer den Zustand danach nicht mehr benötigt (das referenzierte Objekt
 * wird im selben Zug endgültig gelöscht).
 * @param {import('better-sqlite3').Database} db
 * @param {string} refType
 * @param {string} refId
 * @returns {void}
 */
function deleteState(db, refType, refId) {
  db.prepare('DELETE FROM archive_state WHERE ref_type=? AND ref_id=?').run(refType, refId);
}

/**
 * Zahlen für die Sicherheitsabfrage (Endgültig-löschen-Dialog) und die
 * Preflight-Antwort. Geht IMMER von den Topics des Meetings aus (Owner-Check
 * erfolgt vorgelagert im Router über `meetings.user_id`).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} meetingId
 */
function meetingImpact(db, userId, meetingId) {
  const empty = {
    topics: 0, progressEntries: 0, attachments: 0,
    attachmentBytes: 0, themeLinks: 0, stackFrames: 0, aiArtifacts: 0,
  };
  const topicIds = db.prepare('SELECT id FROM topics WHERE meeting_id=?').all(meetingId).map((r) => r.id);
  if (!topicIds.length) return empty;

  const placeholders = topicIds.map(() => '?').join(',');

  const progressRow = db.prepare(
    `SELECT COUNT(*) AS c FROM progress_entries WHERE ref_type='topic' AND ref_id IN (${placeholders})`
  ).get(...topicIds);

  const attRow = db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS bytes FROM attachments WHERE ref_type='topic' AND ref_id IN (${placeholders})`
  ).get(...topicIds);

  const themeLinksRow = db.prepare(
    `SELECT COUNT(*) AS c FROM theme_links WHERE ref_type='topic' AND ref_id IN (${placeholders})`
  ).get(...topicIds);

  const stackRow = db.prepare(
    `SELECT COUNT(*) AS c FROM stack_frames WHERE ref_type='topic' AND ref_id IN (${placeholders})`
  ).get(...topicIds);

  const aiRow = db.prepare(
    `SELECT COUNT(*) AS c FROM ai_artifacts WHERE ref_type='topic' AND ref_id IN (${placeholders})`
  ).get(...topicIds);

  return {
    topics: topicIds.length,
    progressEntries: progressRow.c || 0,
    attachments: attRow.c || 0,
    attachmentBytes: attRow.bytes || 0,
    themeLinks: themeLinksRow.c || 0,
    stackFrames: stackRow.c || 0,
    aiArtifacts: aiRow.c || 0,
  };
}

/**
 * Offene Stack-Frames auf Topics dieses Meetings.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} meetingId
 * @returns {{frameId: string, topicId: string, topicTitle: string, nextStepNote: string, pushedAt: string}[]}
 */
function openStackFramesForMeeting(db, userId, meetingId) {
  const topics = db.prepare('SELECT id, title FROM topics WHERE meeting_id=?').all(meetingId);
  if (!topics.length) return [];
  const titleById = new Map(topics.map((t) => [t.id, t.title]));
  const ids = topics.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, ref_id, next_step_note, pushed_at FROM stack_frames
     WHERE user_id=? AND ref_type='topic' AND ref_id IN (${placeholders}) AND popped_at IS NULL`
  ).all(userId, ...ids);
  return rows.map((r) => ({
    frameId: r.id,
    topicId: r.ref_id,
    topicTitle: titleById.get(r.ref_id) || '',
    nextStepNote: r.next_step_note,
    pushedAt: r.pushed_at,
  }));
}

/**
 * Vollständige, atomare Aufräumung eines archivierten Meetings. EINE
 * `db.transaction()`. Löscht NICHT vom Dateisystem - liefert die
 * `stored_as`-Namen zurück, der Aufrufer (Router) entfernt die Dateien NACH
 * erfolgreichem Commit.
 *
 * Defense-in-Depth: rechnet die Ownership innerhalb derselben Transaktion
 * noch einmal gegen `meetings.user_id` nach (zusätzlich zur Prüfung, die der
 * Router bereits vor dem Aufruf durchführt) - ein Mismatch wirft, wodurch
 * die gesamte Transaktion automatisch zurückgerollt wird und der Aufrufer
 * dies als unerwarteten Fehler (500 PURGE_FAILED) behandeln kann.
 *
 * Reihenfolge: theme_links -> attachments (nur DB-Zeilen) -> stack_frames ->
 * ai_artifacts -> progress.deleteForRefs() -> archive_state -> meetings.
 * `topics` werden NICHT explizit gelöscht (kaskadieren automatisch über den
 * bestehenden FK `topics.meeting_id ON DELETE CASCADE`).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{deleteForRefs: (db: any, refs: {refType:string, refId:string}[]) => {entries: number, meta: number}}} progress
 * @param {string} userId
 * @param {string} meetingId
 * @returns {{deleted: {topics:number, progressEntries:number, attachments:number, themeLinks:number, stackFrames:number, aiArtifacts:number}, storedFiles: string[]}}
 */
function purgeMeeting(db, progress, userId, meetingId) {
  if (!progress || typeof progress.deleteForRefs !== 'function') {
    throw new TypeError('purgeMeeting: progress.deleteForRefs ist erforderlich');
  }

  const deleted = {
    topics: 0, progressEntries: 0, attachments: 0,
    themeLinks: 0, stackFrames: 0, aiArtifacts: 0,
  };
  const storedFiles = [];

  const run = db.transaction(() => {
    const owned = db.prepare('SELECT 1 FROM meetings WHERE id=? AND user_id=?').get(meetingId, userId);
    if (!owned) {
      throw new Error('purgeMeeting: Meeting nicht gefunden oder nicht im Besitz des Nutzers');
    }

    const topicIds = db.prepare('SELECT id FROM topics WHERE meeting_id=?').all(meetingId).map((r) => r.id);
    deleted.topics = topicIds.length;

    if (topicIds.length) {
      const placeholders = topicIds.map(() => '?').join(',');

      const themeLinksDel = db.prepare(
        `DELETE FROM theme_links WHERE ref_type='topic' AND ref_id IN (${placeholders})`
      ).run(...topicIds);
      deleted.themeLinks = themeLinksDel.changes;

      const attRows = db.prepare(
        `SELECT stored_as FROM attachments WHERE ref_type='topic' AND ref_id IN (${placeholders})`
      ).all(...topicIds);
      for (const r of attRows) storedFiles.push(r.stored_as);
      const attDel = db.prepare(
        `DELETE FROM attachments WHERE ref_type='topic' AND ref_id IN (${placeholders})`
      ).run(...topicIds);
      deleted.attachments = attDel.changes;

      const stackDel = db.prepare(
        `DELETE FROM stack_frames WHERE ref_type='topic' AND ref_id IN (${placeholders})`
      ).run(...topicIds);
      deleted.stackFrames = stackDel.changes;

      const aiDel = db.prepare(
        `DELETE FROM ai_artifacts WHERE ref_type='topic' AND ref_id IN (${placeholders})`
      ).run(...topicIds);
      deleted.aiArtifacts = aiDel.changes;

      const progressResult = progress.deleteForRefs(
        db,
        topicIds.map((id) => ({ refType: 'topic', refId: id }))
      );
      deleted.progressEntries = (progressResult && progressResult.entries) || 0;
    }

    db.prepare(`DELETE FROM archive_state WHERE ref_type='meeting' AND ref_id=?`).run(meetingId);
    db.prepare('DELETE FROM meetings WHERE id=?').run(meetingId);
  });

  run();

  return { deleted, storedFiles };
}

/**
 * Listet archivierte Meetings eines Nutzers, optional mit Volltextfilter.
 *
 * `q` ist hier - anders als der Roh-Suchtext aus der HTTP-Query - bereits die
 * fertige FTS5-MATCH-Query-Zeichenkette (das Ergebnis von
 * `ctx.buildFtsQuery(rawQ)`), NICHT der Rohtext selbst. Die Übersetzung
 * Rohtext -> FTS5-Query (inkl. Sonderfall `null`-Rückgabe bei reinen
 * Negativtermen) erfolgt bewusst in routes.js (siehe dortiger Kommentar),
 * analog zum bestehenden `buildFts5Query`-Aufruf direkt in den
 * Such-Routen-Handlern in server.js - queries.js bleibt dadurch frei von
 * HTTP-Query-Parsing.
 *
 * Ein Meeting matcht (wenn `q` gesetzt ist), wenn der Meeting-Eintrag selbst
 * im geteilten `search_index` matcht ODER eines seiner Topics matcht. Kein
 * N+1: maximal zwei FTS5-Queries plus eine Auflösungs-Query
 * (Topic -> Meeting), unabhängig von der Trefferzahl.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{q?: string|null, limit?: number, offset?: number}} [opts]
 * @returns {{rows: object[], total: number}}
 */
function listArchivedMeetings(db, userId, { q = null, limit = 50, offset = 0 } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;

  let idFilter = null;
  if (q) {
    const meetingHits = db.prepare(
      `SELECT ref_id FROM search_index WHERE search_index MATCH ? AND user_id=? AND ref_type='meeting'`
    ).all(q, userId);
    const topicHits = db.prepare(
      `SELECT ref_id FROM search_index WHERE search_index MATCH ? AND user_id=? AND ref_type='topic'`
    ).all(q, userId);

    const meetingIdSet = new Set(meetingHits.map((r) => r.ref_id));
    if (topicHits.length) {
      const topicIds = topicHits.map((r) => r.ref_id);
      const placeholders = topicIds.map(() => '?').join(',');
      const parents = db.prepare(
        `SELECT meeting_id FROM topics WHERE id IN (${placeholders})`
      ).all(...topicIds);
      for (const p of parents) meetingIdSet.add(p.meeting_id);
    }

    idFilter = [...meetingIdSet];
    if (!idFilter.length) return { rows: [], total: 0 };
  }

  const whereParts = ['m.user_id = ?'];
  const params = [userId];
  if (idFilter) {
    whereParts.push(`m.id IN (${idFilter.map(() => '?').join(',')})`);
    params.push(...idFilter);
  }
  const whereSql = whereParts.join(' AND ');

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM meetings m
     JOIN archive_state a ON a.ref_type='meeting' AND a.ref_id=m.id
     WHERE ${whereSql}`
  ).get(...params);
  const total = totalRow ? totalRow.cnt : 0;

  const rows = db.prepare(
    `SELECT m.*, a.archived_at AS archived_at,
       (SELECT COUNT(*) FROM topics t WHERE t.meeting_id = m.id) AS topic_count,
       (SELECT COUNT(*) FROM topics t WHERE t.meeting_id = m.id AND t.done = 0) AS open_topic_count
     FROM meetings m
     JOIN archive_state a ON a.ref_type='meeting' AND a.ref_id=m.id
     WHERE ${whereSql}
     ORDER BY a.archived_at DESC, m.title COLLATE NOCASE ASC
     LIMIT ? OFFSET ?`
  ).all(...params, safeLimit, safeOffset);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      color: r.color,
      participants: JSON.parse(r.participants || '[]'),
      nextDate: r.next_date,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      topicCount: r.topic_count,
      openTopicCount: r.open_topic_count,
    })),
    total,
  };
}

module.exports = {
  ARCHIVABLE_REF_TYPES,
  notArchivedSql,
  isArchived,
  archivedAt,
  isTopicArchived,
  archivedFlags,
  archive,
  restore,
  deleteState,
  meetingImpact,
  openStackFramesForMeeting,
  purgeMeeting,
  listArchivedMeetings,
};
