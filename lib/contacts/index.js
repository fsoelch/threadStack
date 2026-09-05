'use strict';
// Öffentliche API des Ansprechpartner-Moduls (Arbeitspaket B1).
// Re-Export der Teile, die B4 beim Wiring in server.js benötigt.
const { createContactsRouter } = require('./routes');
const { runContactMigrations, ensureContactNoteTriggers, purgeContactOrphans } = require('./schema');
const { migrateContactDescriptions } = require('./migrate-description');
const { ensureDefaultCategories, getOrCreateFallbackCategory } = require('./queries');

module.exports = {
  createContactsRouter,
  runContactMigrations,
  ensureContactNoteTriggers,
  purgeContactOrphans,
  migrateContactDescriptions,
  ensureDefaultCategories,
  getOrCreateFallbackCategory,
};
