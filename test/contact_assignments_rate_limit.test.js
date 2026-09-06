'use strict';
// Nachbesserung Code-Review Fund 12: Direkter Unit-Test für den lokalen
// Rate-Limiter aus lib/contacts/assignments/rate-limit.js (kleine
// windowMs/max-Werte statt der im Router verwendeten 10 Minuten, damit die
// Tests schnell laufen).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createRateLimiter } = require('../lib/contacts/assignments/rate-limit');

function buildApp(limiter) {
  const app = express();
  app.use((req, res, next) => {
    req.session = { uid: req.headers['x-user-id'] };
    next();
  });
  app.get('/x', limiter, (req, res) => res.json({ ok: true }));
  return app;
}

test('Rate-Limiter: Limit greift nach max Aufrufen im Fenster', async () => {
  const limiter = createRateLimiter({ windowMs: 200, max: 2 });
  const app = buildApp(limiter);

  const r1 = await request(app).get('/x').set('x-user-id', 'u1');
  const r2 = await request(app).get('/x').set('x-user-id', 'u1');
  const r3 = await request(app).get('/x').set('x-user-id', 'u1');

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.equal(r3.body.code, 'RATE_LIMITED');
});

test('Rate-Limiter: Fenster läuft ab, danach wieder erlaubt', async () => {
  const limiter = createRateLimiter({ windowMs: 50, max: 1 });
  const app = buildApp(limiter);

  const r1 = await request(app).get('/x').set('x-user-id', 'u1');
  assert.equal(r1.status, 200);

  const blocked = await request(app).get('/x').set('x-user-id', 'u1');
  assert.equal(blocked.status, 429);

  await new Promise((r) => setTimeout(r, 80));

  const r2 = await request(app).get('/x').set('x-user-id', 'u1');
  assert.equal(r2.status, 200);
});

test('Rate-Limiter: Schlüssel-Trennung zwischen zwei uid', async () => {
  const limiter = createRateLimiter({ windowMs: 200, max: 1 });
  const app = buildApp(limiter);

  const a1 = await request(app).get('/x').set('x-user-id', 'a');
  const b1 = await request(app).get('/x').set('x-user-id', 'b');
  assert.equal(a1.status, 200);
  assert.equal(b1.status, 200, 'ein anderer uid darf durch das Limit des ersten nicht blockiert werden');

  const a2 = await request(app).get('/x').set('x-user-id', 'a');
  const b2 = await request(app).get('/x').set('x-user-id', 'b');
  assert.equal(a2.status, 429);
  assert.equal(b2.status, 429);
});
