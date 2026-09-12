'use strict';
// Öffentliche API des Backup-Kernmoduls (Arbeitspaket B1). Re-Export der
// Teile, die B2 (server.js-Wiring) konsumiert - Muster identisch zu
// lib/momentum/index.js.
const { runBackupMigrations } = require('./schema');
const { createBackupRouter } = require('./routes');
const scheduler = require('./scheduler');
const store = require('./store');
const restore = require('./restore');
const queries = require('./queries');

module.exports = {
  runBackupMigrations,
  createBackupRouter,
  startScheduler: scheduler.start,
  ...store,
  ...restore,
  ...queries,
};
