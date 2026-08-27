'use strict';
// Re-Export analog lib/archive/index.js (lib/archive existiert im aktuellen
// Arbeitsstand noch nicht als Referenz — Struktur wurde nach bestem Wissen an
// den beschriebenen Vertrag angelehnt: ein flacher, direkt nutzbarer Namespace).
const constants = require('./constants');
const queries = require('./queries');
const service = require('./service');
const { createSummaryScheduler } = require('./scheduler');
const { createSummaryRouter } = require('./routes');

module.exports = {
  ...constants,
  ...queries,
  ...service,
  createSummaryScheduler,
  createSummaryRouter,
};
