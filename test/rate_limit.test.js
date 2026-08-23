'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createRateLimiter } = require('../lib/rate-limit');

function appWith(limiter, keyHeader = 'x-test-key') {
  const app = express();
  app.use((req, res, next) => {
    req.session = { uid: req.header(keyHeader) || undefined };
    next();
  });
  app.use(limiter);
  app.get('/ping', (req, res) => res.json({ ok: true }));
  return app;
}

test('createRateLimiter: wirft bei ungueltigen Optionen', () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 5 }));
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }));
  assert.throws(() => createRateLimiter({ windowMs: -1, max: 5 }));
});

test('createRateLimiter: laesst bis max Treffer im Fenster durch', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  const app = appWith(limiter);
  for (let i = 0; i < 3; i++) {
    const r = await request(app).get('/ping').set('x-test-key', 'user-a');
    assert.equal(r.status, 200, `Treffer ${i + 1} sollte durchgehen`);
  }
});

test('createRateLimiter: blockt mit 429 nach Ueberschreiten von max', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  const app = appWith(limiter);
  for (let i = 0; i < 3; i++) {
    await request(app).get('/ping').set('x-test-key', 'user-b');
  }
  const r = await request(app).get('/ping').set('x-test-key', 'user-b');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'rate_limited');
  assert.equal(typeof r.body.error, 'string');
  assert.ok(r.body.error.length > 0);
});

test('createRateLimiter: eigene message/code werden verwendet', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1, message: 'Zu viele Änderungen. Bitte kurz warten.', code: 'custom_code' });
  const app = appWith(limiter);
  await request(app).get('/ping').set('x-test-key', 'user-c');
  const r = await request(app).get('/ping').set('x-test-key', 'user-c');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'custom_code');
  assert.equal(r.body.error, 'Zu viele Änderungen. Bitte kurz warten.');
});

test('createRateLimiter: Limit gilt pro Key unabhaengig (kein Cross-User-Blocking)', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1 });
  const app = appWith(limiter);
  const r1 = await request(app).get('/ping').set('x-test-key', 'user-d');
  assert.equal(r1.status, 200);
  const r2 = await request(app).get('/ping').set('x-test-key', 'user-e');
  assert.equal(r2.status, 200, 'anderer User darf nicht vom Limit des ersten betroffen sein');
});

test('createRateLimiter: kein Key -> keine Limitierung (durchgereicht)', async () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1 });
  const app = appWith(limiter);
  const r1 = await request(app).get('/ping');
  const r2 = await request(app).get('/ping');
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});

test('createRateLimiter: Sliding Window - nach Ablauf wieder frei (injizierte now)', async () => {
  let currentTime = 1000000;
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => currentTime });
  const app = appWith(limiter);

  const r1 = await request(app).get('/ping').set('x-test-key', 'user-f');
  assert.equal(r1.status, 200);
  const r2 = await request(app).get('/ping').set('x-test-key', 'user-f');
  assert.equal(r2.status, 429);

  currentTime += 1001; // Fenster verstrichen
  const r3 = await request(app).get('/ping').set('x-test-key', 'user-f');
  assert.equal(r3.status, 200);
});

test('createRateLimiter: 60 Treffer im 10-Minuten-Fenster erlaubt, 61. blockt (Standardkonfiguration lib/progress)', async () => {
  let currentTime = 0;
  const limiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 60, now: () => currentTime });
  const app = appWith(limiter);

  for (let i = 0; i < 60; i++) {
    const r = await request(app).get('/ping').set('x-test-key', 'user-g');
    assert.equal(r.status, 200, `Treffer ${i + 1}/60 sollte durchgehen`);
    currentTime += 10; // weit innerhalb des Fensters
  }
  const r61 = await request(app).get('/ping').set('x-test-key', 'user-g');
  assert.equal(r61.status, 429);
});
