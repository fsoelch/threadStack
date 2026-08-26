'use strict';
const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const path       = require('path');
const { setupEnv, loadServer, cleanup, REPO_ROOT } = require('./helpers');

function tableInfo(db, name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map(c => `${c.name}:${c.type}`).sort().join(',');
}

test('Migrations: zweimal-Start lässt Schema unverändert', async (t) => {
  const dir = setupEnv();
  t.after(() => cleanup(dir));

  // First start
  let { db } = loadServer(REPO_ROOT);
  const snap1 = {
    ai_settings:  tableInfo(db, 'ai_settings'),
    ai_usage:     tableInfo(db, 'ai_usage'),
    ai_artifacts: tableInfo(db, 'ai_artifacts'),
    meetings:     tableInfo(db, 'meetings'),
    topics:       tableInfo(db, 'topics'),
    // Arbeitspaket B1/B2 ("Meetings archivieren statt löschen"): additive
    // Migration muss beim zweiten Start ebenfalls idempotent sein.
    archive_state: tableInfo(db, 'archive_state'),
  };

  // Drop the cached server module so the next loadServer triggers the init path again
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/server.js') || k.includes('/ai/')) delete require.cache[k];
  }
  // Close current DB so SQLite WAL is consistent
  db.close();

  // Second start on the SAME data dir
  ({ db } = loadServer(REPO_ROOT));
  const snap2 = {
    ai_settings:  tableInfo(db, 'ai_settings'),
    ai_usage:     tableInfo(db, 'ai_usage'),
    ai_artifacts: tableInfo(db, 'ai_artifacts'),
    meetings:     tableInfo(db, 'meetings'),
    topics:       tableInfo(db, 'topics'),
    archive_state: tableInfo(db, 'archive_state'),
  };

  assert.deepEqual(snap2, snap1, 'Schema must be identical after a second startup');
});
