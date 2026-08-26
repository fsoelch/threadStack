'use strict';

// Einzige Quelle dieser Werte (Paket S3 — Schnittstelle 7). Andere Module
// (queries.js, scheduler.js, service.js, routes.js) importieren ausschließlich
// von hier, statt Werte zu duplizieren.
module.exports = {
  KINDS: ['progress', 'description'],
  FEATURE_BY_KIND: { progress: 'progress_summary', description: 'description_summary' },
  PROGRESS_MIN_ENTRIES: 2,
  DESCRIPTION_MIN_PLAIN_CHARS: 600,
  DEBOUNCE_MS: 2000,
  MAX_QUEUE_PER_USER: 50,
  MAX_AUTO_CALLS_PER_USER_PER_HOUR: 60,
  MAX_CALLS_PER_JOB: 2,          // 1 Versuch + max. 1 Retry, ausschließlich bei 503
  MAX_REFS_PER_READ: 50,
  CLIENT_POLL_INTERVAL_MS: 2000,
  CLIENT_POLL_MAX_ATTEMPTS: 10,
};
