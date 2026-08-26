'use strict';
const crypto = require('crypto');
const { FEATURE_BY_KIND } = require('./constants');

// Verifiziert beim Merge mit Paket S1 (lib/progress/schema.js): die reale
// Tabelle `progress_entries` hat die Spalten (id, user_id, ref_type, ref_id,
// kind, source, body_html, body_text, link_frame_id, client_token,
// created_at, edited_at) - Klartext liegt in `body_text`, der Änderungs-
// zeitstempel heißt `edited_at` (nicht `updated_at`) und ist NULL bis zur
// ersten Bearbeitung. Zugriff bleibt defensiv (try/catch + Tabellen-
// Existenzcheck), damit ein künftig abweichendes Schema nicht zu einem harten
// Fehler führt, sondern konservativ zu "keine Einträge" degradiert (ohnehin
// kein automatischer Backfill gewünscht).
const PROGRESS_ENTRIES_TABLE = 'progress_entries';

function hasProgressEntriesTable(db) {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(PROGRESS_ENTRIES_TABLE);
    return !!row;
  } catch (_) {
    return false;
  }
}

function logWarn(payload) {
  try { console.warn('[summaries]', JSON.stringify(payload)); } catch (_) { /* Logging darf nie werfen */ }
}

function shortHash(input) {
  return 'sha256:' + crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

// Map<refType, refId[]> aus einer flachen Item-Liste bauen ({refType,refId}).
function groupByRefType(items) {
  const byType = new Map();
  for (const it of (items || [])) {
    if (!it || (it.refType !== 'todo' && it.refType !== 'topic')) continue;
    if (typeof it.refId !== 'string' || !it.refId) continue;
    if (!byType.has(it.refType)) byType.set(it.refType, []);
    byType.get(it.refType).push(it.refId);
  }
  return byType;
}

/**
 * → Map<`${refType}:${refId}`, {entryCount, lastChangeAt, sourceVersion}>
 * Eine GROUP-BY-Query je refType (kein N+1), unabhängig von der Anzahl items.
 */
function progressSourceVersions(db, userId, items) {
  const result = new Map();
  const byType = groupByRefType(items);
  if (!byType.size) return result;

  const tableExists = hasProgressEntriesTable(db);
  for (const [refType, ids] of byType) {
    const uniqueIds = [...new Set(ids)];
    if (!tableExists) {
      for (const refId of uniqueIds) {
        result.set(`${refType}:${refId}`, { entryCount: 0, lastChangeAt: null, sourceVersion: shortHash('0|') });
      }
      continue;
    }
    let rows = [];
    try {
      const placeholders = uniqueIds.map(() => '?').join(',');
      rows = db.prepare(
        `SELECT ref_id AS refId,
                COUNT(*) AS entryCount,
                MAX(COALESCE(edited_at, created_at)) AS lastChangeAt
           FROM ${PROGRESS_ENTRIES_TABLE}
          WHERE user_id = ? AND ref_type = ? AND ref_id IN (${placeholders})
          GROUP BY ref_id`
      ).all(userId, refType, ...uniqueIds);
    } catch (e) {
      logWarn({ kind: 'progress', code: 'schema_mismatch', durationMs: 0, attempt: 0 });
      rows = [];
    }
    const byId = new Map(rows.map(r => [r.refId, r]));
    for (const refId of uniqueIds) {
      const r = byId.get(refId);
      const entryCount = r ? (r.entryCount | 0) : 0;
      const lastChangeAt = r ? r.lastChangeAt : null;
      result.set(`${refType}:${refId}`, {
        entryCount,
        lastChangeAt,
        sourceVersion: shortHash(`${entryCount}|${lastChangeAt || ''}`),
      });
    }
  }
  return result;
}

// Nicht Teil des dokumentierten S3-Schnittstellenvertrags (der keine Methode
// zum Lesen der Fortschritts-Volltexte definiert) — wird intern vom Scheduler
// benötigt, um `entries` für ai.summarizeProgress(...) zu befüllen. Siehe
// Kommentar zu PROGRESS_ENTRIES_TABLE oben.
function loadProgressEntryTexts(db, userId, refType, refId, limit = 50) {
  if (!hasProgressEntriesTable(db)) return [];
  try {
    const rows = db.prepare(
      `SELECT body_text, created_at
         FROM ${PROGRESS_ENTRIES_TABLE}
        WHERE user_id = ? AND ref_type = ? AND ref_id = ? AND kind = 'note'
        ORDER BY created_at ASC
        LIMIT ?`
    ).all(userId, refType, refId, limit);
    return rows.map(r => ({ text: String(r.body_text || ''), createdAt: r.created_at }));
  } catch (e) {
    logWarn({ kind: 'progress', code: 'schema_mismatch', durationMs: 0, attempt: 0 });
    return [];
  }
}

/** → 'sha256:<16 hex>' */
function descriptionSourceVersion(plainText) {
  return shortHash(String(plainText || ''));
}

/**
 * → Map<`${kind}:${refType}:${refId}`, {summary, sourceVersion, model, createdAt}>
 * Liest bestehende KI-Artefakte aus der (von ai/index.js verwalteten) Tabelle
 * ai_artifacts. Eine Query je vorkommendem refType, kein N+1.
 */
function loadArtifacts(db, userId, items) {
  const result = new Map();
  const byType = groupByRefType(items);
  if (!byType.size) return result;

  const features = Object.values(FEATURE_BY_KIND);
  const featurePlaceholders = features.map(() => '?').join(',');
  const kindByFeature = new Map(Object.entries(FEATURE_BY_KIND).map(([k, f]) => [f, k]));

  for (const [refType, ids] of byType) {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) continue;
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT ref_id, feature, content, model, created_at
         FROM ai_artifacts
        WHERE user_id = ? AND ref_type = ? AND feature IN (${featurePlaceholders})
          AND ref_id IN (${placeholders})
        ORDER BY created_at ASC`
    ).all(userId, refType, ...features, ...uniqueIds);

    for (const row of rows) {
      const kind = kindByFeature.get(row.feature);
      if (!kind) continue;
      let parsed;
      try { parsed = JSON.parse(row.content); } catch (_) { continue; }
      if (!parsed || typeof parsed.summary !== 'string') continue;
      // ORDER BY created_at ASC + Map.set: der jeweils neueste Treffer je
      // (kind,refType,refId) überschreibt ältere -> letzter gewinnt.
      result.set(`${kind}:${refType}:${row.ref_id}`, {
        summary: parsed.summary,
        sourceVersion: parsed.sourceVersion || null,
        model: row.model || '',
        createdAt: row.created_at,
      });
    }
  }
  return result;
}

/**
 * Löscht KI-Zusammenfassungen für gegebene Refs. `refs` ist ein Array aus
 * {refType, refId, kind?} — fehlt `kind`, werden beide Arten (progress +
 * description) für die Ref gelöscht. Ausschließlich parametrisierte Queries,
 * IN(...)-Listen nur über generierte '?'.
 * → {deleted:number}
 */
function deleteForRefs(db, userId, refs) {
  if (!Array.isArray(refs) || !refs.length) return { deleted: 0 };
  const allFeatures = Object.values(FEATURE_BY_KIND);
  let deleted = 0;

  const byTypeAnyKind = new Map();   // refType -> Set<refId>
  const specific = [];               // [refType, refId, feature][]

  for (const r of refs) {
    if (!r || (r.refType !== 'todo' && r.refType !== 'topic')) continue;
    if (typeof r.refId !== 'string' || !r.refId) continue;
    if (r.kind && FEATURE_BY_KIND[r.kind]) {
      specific.push([r.refType, r.refId, FEATURE_BY_KIND[r.kind]]);
    } else {
      if (!byTypeAnyKind.has(r.refType)) byTypeAnyKind.set(r.refType, new Set());
      byTypeAnyKind.get(r.refType).add(r.refId);
    }
  }

  for (const [refType, idSet] of byTypeAnyKind) {
    const ids = [...idSet];
    if (!ids.length) continue;
    const idPlaceholders = ids.map(() => '?').join(',');
    const featPlaceholders = allFeatures.map(() => '?').join(',');
    const info = db.prepare(
      `DELETE FROM ai_artifacts
        WHERE user_id = ? AND ref_type = ? AND feature IN (${featPlaceholders})
          AND ref_id IN (${idPlaceholders})`
    ).run(userId, refType, ...allFeatures, ...ids);
    deleted += info.changes;
  }

  for (const [refType, refId, feature] of specific) {
    const info = db.prepare(
      `DELETE FROM ai_artifacts WHERE user_id = ? AND ref_type = ? AND feature = ? AND ref_id = ?`
    ).run(userId, refType, feature, refId);
    deleted += info.changes;
  }

  return { deleted };
}

/**
 * Räumt KI-Zusammenfassungen auf, deren Todo/Topic nicht mehr existiert
 * (z. B. Server-Neustart nach direktem DB-Eingriff / Cascade-Deletes, die
 * `deleteForRefs` verpasst haben könnten). Wird beim Serverstart aufgerufen.
 * → {deleted:number}
 */
function purgeSummaryOrphans(db) {
  const features = Object.values(FEATURE_BY_KIND);
  const fPlace = features.map(() => '?').join(',');
  const info = db.prepare(
    `DELETE FROM ai_artifacts
      WHERE id IN (
        SELECT a.id FROM ai_artifacts a
        WHERE a.feature IN (${fPlace})
          AND (
            (a.ref_type='todo'  AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.id=a.ref_id AND t.user_id=a.user_id))
            OR
            (a.ref_type='topic' AND NOT EXISTS (
              SELECT 1 FROM topics tp JOIN meetings m ON m.id=tp.meeting_id
               WHERE tp.id=a.ref_id AND m.user_id=a.user_id
            ))
            OR (a.ref_type NOT IN ('todo','topic'))
          )
      )`
  ).run(...features);
  return { deleted: info.changes };
}

module.exports = {
  progressSourceVersions,
  descriptionSourceVersion,
  loadArtifacts,
  deleteForRefs,
  purgeSummaryOrphans,
  // Interner Helfer, kein Bestandteil des dokumentierten Vertrags (s.o.).
  loadProgressEntryTexts,
  // Test-/Diagnose-Helfer
  _internals: { hasProgressEntriesTable, PROGRESS_ENTRIES_TABLE, shortHash },
};
