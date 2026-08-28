'use strict';
// Re-Export analog lib/archive/index.js: ein flacher, direkt nutzbarer
// Namespace.
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
