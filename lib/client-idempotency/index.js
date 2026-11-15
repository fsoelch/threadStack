'use strict';
const { runClientIdempotencyMigrations, purgeExpiredClientTokens } = require('./schema');
const queries = require('./queries');
const { createSyncRouter } = require('./routes');

module.exports = {
  CLIENT_TOKEN_RE: queries.CLIENT_TOKEN_RE,
  runClientIdempotencyMigrations,
  purgeExpiredClientTokens,
  parseClientToken: queries.parseClientToken,
  parseCapturedAt: queries.parseCapturedAt,
  lookupClientToken: queries.lookupClientToken,
  recordClientToken: queries.recordClientToken,
  createSyncRouter,
};
