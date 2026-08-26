'use strict';
const {
  KINDS, FEATURE_BY_KIND, PROGRESS_MIN_ENTRIES, DESCRIPTION_MIN_PLAIN_CHARS,
  DEBOUNCE_MS, MAX_QUEUE_PER_USER, MAX_AUTO_CALLS_PER_USER_PER_HOUR, MAX_CALLS_PER_JOB,
} = require('./constants');
const queries = require('./queries');
const { htmlToText } = require('../sanitize');

// Nicht Teil von constants.js (dort bewusst nur die dort explizit gelisteten
// Werte, siehe Kommentar in constants.js), aber Teil der bindenden
// Scheduler-Semantik aus dem Architektur-Vertrag.
const RETRY_DELAY_MS = 3000;
const ERROR_TTL_MS = 15 * 60 * 1000;
const HOUR_WINDOW_MS = 60 * 60 * 1000;

function logWarn(payload) {
  try { console.warn('[summaries]', JSON.stringify(payload)); } catch (_) { /* Logging darf nie werfen */ }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * createSummaryScheduler({ db, encryptionKey, ai, now, enabled })
 *
 * `ai` wird als vollständiges ai/index.js-Modulobjekt erwartet (liefert u. a.
 * loadSettings/assertActive sowie — nach Merge mit Paket S2 — summarizeProgress
 * und summarizeDescription). ANNAHME, siehe Abschlussbericht Paket S3.
 */
function createSummaryScheduler({ db, encryptionKey, ai, now = () => new Date(), enabled = true }) {
  const jobs = new Map();        // key -> jobRecord
  const errors = new Map();      // key -> {errorCode, at, expiresAt}
  const readyQueue = [];         // key[]
  const autoCallLog = new Map(); // userId -> epochMs[]
  let workerRunning = false;
  let stopped = false;
  let fastForward = false;       // aktiviert von drain(): Debounce/Retry ohne Echtzeit-Wartezeit
  let archiveOverride;           // Test-Seam, siehe _setArchiveForTests

  function keyOf(userId, kind, refType, refId) { return `${userId}|${kind}|${refType}|${refId}`; }

  function wait(ms) { return sleep(fastForward ? 0 : ms); }

  function pruneErrors() {
    const t = now().getTime();
    for (const [k, v] of errors) if (v.expiresAt <= t) errors.delete(k);
  }

  function countActiveJobsForUser(userId) {
    let c = 0;
    for (const j of jobs.values()) if (j.userId === userId) c++;
    return c;
  }

  function pruneAutoCalls(userId) {
    const t = now().getTime();
    const arr = (autoCallLog.get(userId) || []).filter(ts => t - ts < HOUR_WINDOW_MS);
    autoCallLog.set(userId, arr);
    return arr;
  }

  function hourCapReached(userId) {
    return pruneAutoCalls(userId).length >= MAX_AUTO_CALLS_PER_USER_PER_HOUR;
  }

  function recordAutoCall(userId) {
    const arr = pruneAutoCalls(userId);
    arr.push(now().getTime());
    autoCallLog.set(userId, arr);
  }

  function getArchive() {
    if (archiveOverride !== undefined) return archiveOverride;
    try { return require('../archive'); } catch (_) { return null; }
  }

  function isTopicArchived(refId) {
    const mod = getArchive();
    if (!mod || typeof mod.isTopicArchived !== 'function') return false;
    try { return !!mod.isTopicArchived(db, refId); } catch (_) { return false; }
  }

  function loadRefInfo(refType, refId, userId) {
    if (refType === 'todo') {
      const row = db.prepare('SELECT done, description FROM todos WHERE id=? AND user_id=?').get(refId, userId);
      if (!row) return null;
      return { done: !!row.done, description: row.description, archived: false };
    }
    if (refType === 'topic') {
      const row = db.prepare(
        `SELECT t.done AS done, t.description AS description
           FROM topics t JOIN meetings m ON m.id=t.meeting_id
          WHERE t.id=? AND m.user_id=?`
      ).get(refId, userId);
      if (!row) return null;
      return { done: !!row.done, description: row.description, archived: isTopicArchived(refId) };
    }
    return null;
  }

  function safeDeleteForRefs(userId, refType, refId, kind) {
    try { queries.deleteForRefs(db, userId, [{ refType, refId, kind }]); }
    catch (_) { /* best effort, darf enqueue()/runJob() nie zum Absturz bringen */ }
  }

  function checkThresholdOk(kind, refType, refId, userId, refInfo) {
    if (kind === 'progress') {
      const versions = queries.progressSourceVersions(db, userId, [{ refType, refId }]);
      const v = versions.get(`${refType}:${refId}`) || { entryCount: 0, sourceVersion: null };
      return { ok: v.entryCount >= PROGRESS_MIN_ENTRIES, sourceVersion: v.sourceVersion };
    }
    const plain = htmlToText(refInfo.description || '');
    return { ok: plain.length >= DESCRIPTION_MIN_PLAIN_CHARS, sourceVersion: queries.descriptionSourceVersion(plain), plain };
  }

  function isGateOpen(userId, kind) {
    let settings;
    try { settings = ai.loadSettings(db, userId); } catch (_) { return null; }
    try { ai.assertActive(settings, FEATURE_BY_KIND[kind]); } catch (_) { return null; }
    return settings;
  }

  function enqueue({ userId, kind, refType, refId, reason, confirmed = false }) {
    try {
      if (stopped || !enabled) return false;
      if (!userId || !refId) return false;
      if (!KINDS.includes(kind)) return false;
      if (refType !== 'todo' && refType !== 'topic') return false;

      const settings = isGateOpen(userId, kind);
      if (!settings) return false; // Feature aus / globally_disabled / kein Provider|Key

      const refInfo = loadRefInfo(refType, refId, userId);
      if (!refInfo) return false;                 // Ref nicht gefunden / fremd
      if (refInfo.done) return false;              // Ref erledigt
      if (refType === 'topic' && refInfo.archived) return false; // Topic archiviert

      const threshold = checkThresholdOk(kind, refType, refId, userId, refInfo);
      if (!threshold.ok) {
        safeDeleteForRefs(userId, refType, refId, kind);
        return false;
      }

      const key = keyOf(userId, kind, refType, refId);
      let job = jobs.get(key);

      if (!job) {
        if (countActiveJobsForUser(userId) >= MAX_QUEUE_PER_USER) {
          logWarn({ kind, code: 'queue_cap', durationMs: 0, attempt: 0, uid: userId });
          return false;
        }
        if (hourCapReached(userId)) {
          logWarn({ kind, code: 'hour_cap', durationMs: 0, attempt: 0, uid: userId });
          return false;
        }
        job = {
          userId, kind, refType, refId, reason, confirmed,
          attempt: 0, state: 'debouncing', pendingRerun: false, timer: null,
        };
        jobs.set(key, job);
        job.timer = setTimeout(() => fireDebounce(key), fastForward ? 0 : DEBOUNCE_MS);
        return true;
      }

      // Coalescing: derselbe Schlüssel → kein zweiter Job.
      job.reason = reason;
      job.confirmed = job.confirmed || confirmed;
      if (job.state === 'debouncing') {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => fireDebounce(key), fastForward ? 0 : DEBOUNCE_MS);
      } else if (job.state === 'running') {
        job.pendingRerun = true;
      }
      // state 'queued': läuft ohnehin bald mit aktualisiertem reason/confirmed an.
      return true;
    } catch (e) {
      logWarn({ kind, code: 'enqueue_error', durationMs: 0, attempt: 0 });
      return false;
    }
  }

  function fireDebounce(key) {
    const job = jobs.get(key);
    if (!job) return;
    job.timer = null;
    job.state = 'queued';
    if (!readyQueue.includes(key)) readyQueue.push(key);
    kickWorker();
  }

  function kickWorker() {
    if (workerRunning) return;
    workerRunning = true;
    (async () => {
      while (readyQueue.length) {
        const key = readyQueue.shift();
        await runJob(key);
      }
      workerRunning = false;
    })().catch(e => {
      workerRunning = false;
      logWarn({ kind: 'unknown', code: 'worker_crash', durationMs: 0, attempt: 0 });
    });
  }

  async function runJob(key) {
    const job = jobs.get(key);
    if (!job) return;
    job.state = 'running';
    const { userId, kind, refType, refId } = job;
    const maxAttempts = MAX_CALLS_PER_JOB;
    let attempt = 0;

    while (true) {
      attempt++;
      const startedAt = now().getTime();
      try {
        const settings = isGateOpen(userId, kind);
        if (!settings) break; // inzwischen deaktiviert -> stiller Abbruch, kein Fehlerstatus

        const refInfo = loadRefInfo(refType, refId, userId);
        if (!refInfo || refInfo.done) break;
        if (refType === 'topic' && refInfo.archived) break;

        const threshold = checkThresholdOk(kind, refType, refId, userId, refInfo);
        if (!threshold.ok) { safeDeleteForRefs(userId, refType, refId, kind); break; }

        if (hourCapReached(userId)) {
          logWarn({ kind, code: 'hour_cap', durationMs: now().getTime() - startedAt, attempt, uid: userId });
          break;
        }
        recordAutoCall(userId);

        if (kind === 'progress') {
          const entries = queries.loadProgressEntryTexts(db, userId, refType, refId);
          await ai.summarizeProgress({
            db, userId, settings, encryptionKey, refType, refId,
            entries, sourceVersion: threshold.sourceVersion, confirmed: job.confirmed,
          });
        } else {
          await ai.summarizeDescription({
            db, userId, settings, encryptionKey, refType, refId,
            descriptionText: threshold.plain, sourceVersion: threshold.sourceVersion, confirmed: job.confirmed,
          });
        }
        errors.delete(key);
        logWarn({ kind, code: 'ok', durationMs: now().getTime() - startedAt, attempt });
        break;
      } catch (e) {
        const status = e && e.httpStatus;
        if (status === 503 && attempt < maxAttempts) {
          logWarn({ kind, code: 'retry_503', durationMs: now().getTime() - startedAt, attempt });
          await wait(RETRY_DELAY_MS);
          continue;
        }
        let code;
        if (status === 402) code = 'budget_exceeded';
        else if (status === 428) code = 'confirmation_required';
        else if (status === 422) code = 'generation_failed';
        else if (status === 503) code = 'ai_unavailable';
        else if (status === 409) {
          // AI wurde zwischen Enqueue und Ausführung deaktiviert/umkonfiguriert
          // -> wie "disabled" behandeln, kein Nutzer-Fehler.
          logWarn({ kind, code: 'disabled_race', durationMs: now().getTime() - startedAt, attempt });
          break;
        } else {
          code = 'generation_failed';
        }
        errors.set(key, { errorCode: code, at: now().toISOString(), expiresAt: now().getTime() + ERROR_TTL_MS });
        logWarn({ kind, code, durationMs: now().getTime() - startedAt, attempt });
        break;
      }
    }
    finishJob(key);
  }

  function finishJob(key) {
    const job = jobs.get(key);
    if (!job) return;
    if (job.pendingRerun) {
      job.pendingRerun = false;
      job.attempt = 0;
      job.state = 'debouncing';
      job.timer = setTimeout(() => fireDebounce(key), fastForward ? 0 : DEBOUNCE_MS);
    } else {
      jobs.delete(key);
    }
  }

  function status(userId, kind, refType, refId) {
    pruneErrors();
    const key = keyOf(userId, kind, refType, refId);
    if (jobs.has(key)) return { state: 'pending', at: now().toISOString() };
    const err = errors.get(key);
    if (err) return { state: 'error', errorCode: err.errorCode, at: err.at };
    return null;
  }

  // Test-Seam: lässt alle anstehenden Debounce-/Retry-Timer sofort ablaufen
  // und wartet, bis die Warteschlange vollständig leer ist.
  async function drain() {
    fastForward = true;
    try {
      let guard = 0;
      const settle = () => new Promise(resolve => setImmediate(resolve));
      while ((jobs.size > 0 || readyQueue.length > 0 || workerRunning) && guard < 20000) {
        for (const [key, job] of jobs) {
          if (job.state === 'debouncing' && job.timer) {
            clearTimeout(job.timer);
            job.timer = null;
            fireDebounce(key);
          }
        }
        await settle();
        guard++;
      }
    } finally {
      fastForward = false;
    }
  }

  function stop() {
    stopped = true;
    for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer);
    jobs.clear();
    readyQueue.length = 0;
  }

  return {
    enqueue,
    status,
    drain,
    stop,
    // Test-Seam (nicht Teil des dokumentierten Vertrags): erlaubt, das
    // optionale lib/archive für Tests durch ein Mock zu ersetzen, solange das
    // reale Modul in diesem Arbeitsstand nicht existiert.
    _setArchiveForTests(mod) { archiveOverride = mod; },
  };
}

module.exports = { createSummaryScheduler };
