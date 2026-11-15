'use strict';
const express = require('express');

function createSyncRouter({ requireAuth }) {
  const router = express.Router();
  router.get('/capabilities', requireAuth, (req, res) => {
    res.json({ idempotentCreate: { version: 1, refTypes: ['todo', 'topic'] }, capturedAt: true });
  });
  return router;
}

module.exports = { createSyncRouter };
