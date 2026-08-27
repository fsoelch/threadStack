'use strict';
const { KINDS, FEATURE_BY_KIND, PROGRESS_MIN_ENTRIES, DESCRIPTION_MIN_PLAIN_CHARS } = require('./constants');
const queries = require('./queries');
const { htmlToText } = require('../sanitize');

let aiOverride;
function getAi() {
  if (aiOverride !== undefined) return aiOverride;
  return require('../../ai');
}

let archiveOverride;
function getArchive() {
  if (archiveOverride !== undefined) return archiveOverride;
  try { return require('../archive'); } catch (_) { return null; }
}

function isTopicArchived(db, refType, refId) {
  if (refType !== 'topic') return false;
  const mod = getArchive();
  if (!mod || typeof mod.isTopicArchived !== 'function') return false;
  try { return !!mod.isTopicArchived(db, refId); } catch (_) { return false; }
}

function emptyView() {
  return { status: 'not_applicable', text: null, generatedAt: null, model: null, errorCode: null };
}
function disabledView() {
  return { status: 'disabled', text: null, generatedAt: null, model: null, errorCode: null };
}

// Batch-Lookup von {done, description} je Ref, eine Query je vorkommendem
// refType (kein N+1).
function loadRefRows(db, userId, items) {
  const todoIds = [];
  const topicIds = [];
  for (const it of items) {
    if (!it) continue;
    if (it.refType === 'todo') todoIds.push(it.refId);
    else if (it.refType === 'topic') topicIds.push(it.refId);
  }
  const byKey = new Map();
  if (todoIds.length) {
    const uniq = [...new Set(todoIds)];
    const placeholders = uniq.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, done, description FROM todos WHERE user_id=? AND id IN (${placeholders})`
    ).all(userId, ...uniq);
    for (const r of rows) byKey.set(`todo:${r.id}`, { done: !!r.done, description: r.description });
  }
  if (topicIds.length) {
    const uniq = [...new Set(topicIds)];
    const placeholders = uniq.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT t.id AS id, t.done AS done, t.description AS description
         FROM topics t JOIN meetings m ON m.id=t.meeting_id
        WHERE m.user_id=? AND t.id IN (${placeholders})`
    ).all(userId, ...uniq);
    for (const r of rows) byKey.set(`topic:${r.id}`, { done: !!r.done, description: r.description });
  }
  return byKey;
}

/**
 * forRefs(db, userId, items, { settings, scheduler }) → Map<`${refType}:${refId}`, SummaryView>
 * SummaryView = { progress: {status,text,generatedAt,model,errorCode}, description: {...} }
 *
 * Verarbeitet ALLE übergebenen items (keine interne Größenbegrenzung) — die
 * 50er-Obergrenze aus MAX_REFS_PER_READ gilt gemäß Vertrag ausschließlich für
 * die Größenvalidierung des öffentlichen `refs`-Query-Parameters in routes.js,
 * nicht für interne Batch-Anreicherung von Listen-Endpunkten (Schnittstelle 9,
 * z. B. 200 Todos). Siehe Abschlussbericht.
 *
 * Löst NIEMALS einen KI-Aufruf aus — reine Lesefunktion.
 */
function forRefs(db, userId, items, { settings, scheduler } = {}) {
  const result = new Map();
  const safeItems = (Array.isArray(items) ? items : [])
    .filter(it => it && (it.refType === 'todo' || it.refType === 'topic') && typeof it.refId === 'string' && it.refId);
  if (!safeItems.length) return result;

  const ai = getAi();
  const disabledByKind = {};
  for (const kind of KINDS) {
    try { ai.assertActive(settings, FEATURE_BY_KIND[kind]); disabledByKind[kind] = false; }
    catch (_) { disabledByKind[kind] = true; }
  }

  const refRows = loadRefRows(db, userId, safeItems);
  // Refs, die nicht existieren oder nicht dem Nutzer gehören: kommentarlos
  // weglassen (keine Existenz-Enumeration) — nicht Teil des Ergebnisses.
  const existingItems = safeItems.filter(it => refRows.has(`${it.refType}:${it.refId}`));
  if (!existingItems.length) return result;

  const progressVersions = queries.progressSourceVersions(db, userId, existingItems);

  const artifactLookupItems = [];
  const applicability = new Map(); // `${kind}:${refType}:${refId}` -> {applicable, currentSourceVersion}

  for (const it of existingItems) {
    const refKey = `${it.refType}:${it.refId}`;
    const row = refRows.get(refKey);
    result.set(refKey, { progress: emptyView(), description: emptyView() });

    for (const kind of KINDS) {
      const artKey = `${kind}:${refKey}`;

      // "Ist KI deaktiviert: forRefs liefert ohne DB-Zugriff auf ai_artifacts
      // sofort disabled" — disabled hat Vorrang vor not_applicable und spart
      // zusätzlich die Schwellwert-/Archiv-Prüfung (kein weiterer DB-Zugriff).
      if (disabledByKind[kind]) {
        applicability.set(artKey, { disabled: true, applicable: false, currentSourceVersion: null });
        continue;
      }

      let applicable = true;
      let currentSourceVersion = null;

      if (row.done) applicable = false;
      if (applicable && isTopicArchived(db, it.refType, it.refId)) applicable = false;

      if (applicable && kind === 'progress') {
        const v = progressVersions.get(refKey) || { entryCount: 0, sourceVersion: null };
        if (v.entryCount < PROGRESS_MIN_ENTRIES) applicable = false;
        else currentSourceVersion = v.sourceVersion;
      } else if (applicable && kind === 'description') {
        const plain = htmlToText(row.description || '');
        if (plain.length < DESCRIPTION_MIN_PLAIN_CHARS) applicable = false;
        else currentSourceVersion = queries.descriptionSourceVersion(plain);
      }

      applicability.set(artKey, { disabled: false, applicable, currentSourceVersion });
      if (applicable) artifactLookupItems.push(it);
    }
  }

  const artifacts = artifactLookupItems.length
    ? queries.loadArtifacts(db, userId, artifactLookupItems)
    : new Map();

  for (const it of existingItems) {
    const refKey = `${it.refType}:${it.refId}`;
    const view = result.get(refKey);

    for (const kind of KINDS) {
      const artKey = `${kind}:${refKey}`;
      const info = applicability.get(artKey);
      if (info.disabled) { view[kind] = disabledView(); continue; }
      if (!info.applicable) continue; // bleibt emptyView (not_applicable)

      const schedStatus = scheduler ? scheduler.status(userId, kind, it.refType, it.refId) : null;
      if (schedStatus && schedStatus.state === 'pending') {
        view[kind] = { status: 'pending', text: null, generatedAt: null, model: null, errorCode: null };
        continue;
      }
      if (schedStatus && schedStatus.state === 'error') {
        view[kind] = { status: 'error', text: null, generatedAt: null, model: null, errorCode: schedStatus.errorCode || 'generation_failed' };
        continue;
      }

      const artifact = artifacts.get(artKey);
      if (!artifact) continue; // anwendbar, aber (noch) nie generiert -> not_applicable (kein Backfill)

      if (artifact.sourceVersion && artifact.sourceVersion === info.currentSourceVersion) {
        view[kind] = { status: 'ready', text: artifact.summary, generatedAt: artifact.createdAt, model: artifact.model, errorCode: null };
      } else {
        view[kind] = { status: 'stale', text: artifact.summary, generatedAt: artifact.createdAt, model: artifact.model, errorCode: null };
      }
    }
  }

  return result;
}

let _scheduler = null;
/**
 * Nicht Teil des dokumentierten S3-Vertrags für service.js (der onXChanged
 * ohne scheduler-Parameter beschreibt), aber notwendig, damit
 * onProgressEntriesChanged/onDescriptionChanged als fertig gebundene
 * (ctx) => {enqueued} Hooks — z. B. direkt als
 * createProgressRouter({ onProgressEntriesChanged }) — weitergereicht werden
 * können. Muss vor Nutzung der Hooks einmalig aufgerufen werden
 * (server.js-Wiring). Siehe Abschlussbericht.
 */
function configure({ scheduler } = {}) {
  _scheduler = scheduler || null;
}

// (ctx: {userId, refType:'todo'|'topic', refId, reason:'created'|'updated'|'deleted'}) => {enqueued:boolean}
// Muss synchron zurückkehren und darf nie werfen (Vertrag von Paket S1).
function onProgressEntriesChanged(ctx) {
  try {
    if (!_scheduler || !ctx) return { enqueued: false };
    const ok = _scheduler.enqueue({
      userId: ctx.userId, kind: 'progress', refType: ctx.refType, refId: ctx.refId,
      reason: ctx.reason, confirmed: false,
    });
    return { enqueued: !!ok };
  } catch (_) {
    return { enqueued: false };
  }
}

function onDescriptionChanged(ctx) {
  try {
    if (!_scheduler || !ctx) return { enqueued: false };
    const ok = _scheduler.enqueue({
      userId: ctx.userId, kind: 'description', refType: ctx.refType, refId: ctx.refId,
      reason: ctx.reason || 'updated', confirmed: false,
    });
    return { enqueued: !!ok };
  } catch (_) {
    return { enqueued: false };
  }
}

module.exports = {
  forRefs,
  onProgressEntriesChanged,
  onDescriptionChanged,
  configure,
  // Test-Seams (nicht Teil des dokumentierten Vertrags)
  _setAiForTests(mod) { aiOverride = mod; },
  _setArchiveForTests(mod) { archiveOverride = mod; },
  _resetSchedulerForTests() { _scheduler = null; },
};
