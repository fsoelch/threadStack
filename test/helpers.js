'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

// Each test gets its own temp data dir so they can't collide.
function setupEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadstack-test-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  // Point the server at a temp data dir; don't touch __dirname
  process.env.DATA_DIR = path.join(dir, 'data');
  process.env.PORT = '0';
  process.env.BASE_PATH = '/';  // trailing slash gets stripped → BASE=''
  process.env.AI_PROVIDER_OVERRIDE = 'mock';
  // Force a fresh require cache so each test gets its own DB connection
  // (better-sqlite3 holds a process-wide file handle otherwise).
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/server.js') || k.includes('/ai/')) delete require.cache[k];
  }
  return dir;
}

function loadServer(repoRoot) {
  return require(path.join(repoRoot, 'server.js'));
}

async function login(request, app, username, password) {
  // request = supertest function (already bound to app)
  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ username, password });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

// Bootstraps an admin user with a known password by writing directly to the DB.
// (The real server prints a random admin password on first run; for tests we
// just overwrite it after init.)
function ensureTestAdmin(db, password = 'test12345') {
  const bcrypt = require('bcryptjs');
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
  if (existing) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), existing.id);
    return { id: existing.id, username: 'admin', password };
  }
  const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, 'admin', bcrypt.hashSync(password, 10), 'admin', new Date().toISOString());
  return { id, username: 'admin', password };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

const REPO_ROOT = path.resolve(__dirname, '..');

module.exports = { setupEnv, loadServer, login, ensureTestAdmin, cleanup, REPO_ROOT };
