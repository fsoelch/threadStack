'use strict';
// Öffentliche API des Archiv-Kernmoduls (Arbeitspaket B1, "Meetings
// archivieren statt löschen"). Re-Export der Teile, die B2 beim Wiring in
// server.js benötigt.
const { createArchiveRouter } = require('./routes');
const { runArchiveMigrations, purgeArchiveOrphans } = require('./schema');
const queries = require('./queries');

module.exports = {
  runArchiveMigrations,
  purgeArchiveOrphans,
  createArchiveRouter,
  ARCHIVABLE_REF_TYPES: queries.ARCHIVABLE_REF_TYPES,
  // Direktzugriff auf die Query-Schicht (z.B. für B2/B3, um `notArchivedSql`,
  // `archivedFlags`, `isTopicArchived` etc. außerhalb des Routers zu nutzen).
  ...queries,
};
