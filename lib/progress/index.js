'use strict';
// Öffentliche API des Fortschrittsverlauf-Moduls (Arbeitspaket S1).
// Re-Export der Teile, die S2 beim Wiring in server.js benötigt.
const { createProgressRouter } = require('./routes');
const { runProgressMigrations, purgeProgressOrphans, dropProgressGoal } = require('./schema');
const queries = require('./queries');
const sanitize = require('./sanitize');

module.exports = {
  createProgressRouter,
  runProgressMigrations,
  purgeProgressOrphans,
  dropProgressGoal,
  // Direktzugriff auf die Query-Schicht (z.B. für S2s Stack-Integration:
  // setNextStep()/deleteForRefs() werden dort aus server.js heraus aufgerufen).
  ...queries,
  // Sanitizing-Helfer, falls S2 sie außerhalb des Routers benötigt
  // (z.B. um Zwischenstände aus dem Stack-Pop-Flow zu erzeugen).
  ...sanitize,
};
