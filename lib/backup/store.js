'use strict';
// Datei-Operationen fuer DB-Backups (Arbeitspaket B1). Reine Funktionen auf
// Dateisystem + `db` - kein Express, kein Import aus server.js.
//
// Backup-Metadaten stehen bewusst NUR im Dateinamen
// (`backup-<type>-<YYYYMMDD>-<HHmmss>.sqlite`), es gibt KEINE DB-Tabelle fuer
// die Liste - vermeidet Zirkularitaet (die Liste waere sonst selbst Teil des
// per Restore ueberschriebenen Zustands). `type` ist eine feste Allowlist,
// niemals aus Nutzereingabe generiert.
const fs = require('fs');
const path = require('path');

const TYPES = ['manual', 'auto', 'prerestore'];
const FILENAME_RE = /^backup-(manual|auto|prerestore)-(\d{8})-(\d{6})\.sqlite$/;

function pad2(n) { return String(n).padStart(2, '0'); }

function timestampParts(date) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return { dateStr: `${y}${m}${d}`, timeStr: `${hh}${mm}${ss}` };
}

function buildFilename(type, date) {
  if (!TYPES.includes(type)) throw new Error(`store.buildFilename: unbekannter type "${type}"`);
  const { dateStr, timeStr } = timestampParts(date);
  return `backup-${type}-${dateStr}-${timeStr}.sqlite`;
}

// Einzige Stelle, die einen von aussen kommenden Dateinamen als gueltigen
// Backup-Dateinamen akzeptiert - Allowlist-Regex VOR jeder Pfadbildung
// (Path-Traversal-Schutz), siehe zusaetzlich `resolveBackupPath` fuer den
// Containment-Check als Defense-in-Depth.
function parseFilename(filename) {
  const m = FILENAME_RE.exec(String(filename || ''));
  if (!m) return null;
  const [, type, dateStr, timeStr] = m;
  const iso = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}:${timeStr.slice(4, 6)}`;
  return { type, createdAt: iso };
}

// Loest einen Backup-Dateinamen zu einem absoluten Pfad auf und stellt
// sicher, dass das Ergebnis wirklich innerhalb von `backupsDir` liegt (Defense-
// in-Depth, Muster aus server.js `attachments/download`-Route) - auch wenn
// `parseFilename` bereits jede Traversal-Zeichenfolge per Regex ausschliesst.
function resolveBackupPath(backupsDir, filename) {
  const resolved = path.resolve(backupsDir, filename);
  const base = path.resolve(backupsDir) + path.sep;
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

class InvalidFilenameError extends Error {
  constructor() { super('Ungültiger Backup-Dateiname.'); this.code = 'INVALID_FILENAME'; }
}
class BackupNotFoundError extends Error {
  constructor() { super('Backup nicht gefunden.'); this.code = 'NOT_FOUND'; }
}

function ensureValidFilename(backupsDir, filename) {
  const meta = parseFilename(filename);
  if (!meta) throw new InvalidFilenameError();
  const filePath = resolveBackupPath(backupsDir, filename);
  if (!filePath) throw new InvalidFilenameError();
  return { meta, filePath };
}

async function createBackup(db, { backupsDir, type, now = () => new Date() }) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const filename = buildFilename(type, now());
  const filePath = path.join(backupsDir, filename);
  await db.backup(filePath);
  const stat = fs.statSync(filePath);
  const meta = parseFilename(filename);
  return { filename, type: meta.type, createdAt: meta.createdAt, sizeBytes: stat.size };
}

function listBackups(backupsDir) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const entries = fs.readdirSync(backupsDir);
  const backups = [];
  for (const filename of entries) {
    const meta = parseFilename(filename);
    if (!meta) continue; // Fremde/unerwartete Dateien werden stillschweigend ignoriert, nicht gelistet.
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(path.join(backupsDir, filename)).size; } catch (_) { continue; }
    backups.push({ filename, type: meta.type, createdAt: meta.createdAt, sizeBytes });
  }
  backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return backups;
}

function deleteBackup(backupsDir, filename) {
  const { filePath } = ensureValidFilename(backupsDir, filename);
  if (!fs.existsSync(filePath)) throw new BackupNotFoundError();
  fs.unlinkSync(filePath);
}

// Loescht ausschliesslich ueberzaehlige 'auto'-Backups (aelteste zuerst) -
// 'manual'/'prerestore' bleiben von der Aufbewahrungsgrenze unberuehrt.
function applyRetention(backupsDir, retentionCount) {
  const autoBackups = listBackups(backupsDir)
    .filter((b) => b.type === 'auto')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const excess = autoBackups.length - retentionCount;
  if (excess <= 0) return { removed: 0 };
  let removed = 0;
  for (const b of autoBackups.slice(0, excess)) {
    try { deleteBackup(backupsDir, b.filename); removed++; } catch (_) { /* bereits weg, ignorieren */ }
  }
  return { removed };
}

// Gemeinsamer In-Memory-Lock fuer ALLE mutierenden Backup-Operationen
// (Create/Restore/Restore-Upload teilen sich EINEN Zustand, nicht separate
// Locks) - verhindert, dass z.B. ein manuelles Backup waehrend eines laufenden
// Restores gestartet wird. Rein Prozess-lokal (Single-Node-Deployment, siehe
// bestehendes Muster in export/index.js).
let backupInProgress = false;

function isBackupInProgress() { return backupInProgress; }

async function withBackupLock(fn) {
  if (backupInProgress) {
    const err = new Error('Es läuft bereits eine Backup-Operation.');
    err.code = 'BACKUP_IN_PROGRESS';
    throw err;
  }
  backupInProgress = true;
  try {
    return await fn();
  } finally {
    backupInProgress = false;
  }
}

// Eigener Sliding-Window-Rate-Limiter (State getrennt vom generischen
// lib/rate-limit.js-Middleware-Modul, da hier auch NICHT-HTTP-Aufrufe wie der
// Scheduler denselben Schutz durchlaufen sollen) - 5 Aufrufe/10 Minuten je
// Admin-User, analog export/index.js.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const rateHits = new Map(); // userId -> number[]

function checkBackupRate(userId, now = Date.now()) {
  const arr = (rateHits.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { rateHits.set(userId, arr); return false; }
  arr.push(now);
  rateHits.set(userId, arr);
  return true;
}

// Test-Seam: setzt Lock- und Rate-Limit-Zustand zurueck (Modul-State ist
// sonst prozessweit persistent und wuerde Tests gegenseitig beeinflussen).
function _resetForTests() {
  backupInProgress = false;
  rateHits.clear();
}

module.exports = {
  TYPES,
  buildFilename,
  parseFilename,
  resolveBackupPath,
  ensureValidFilename,
  createBackup,
  listBackups,
  deleteBackup,
  applyRetention,
  withBackupLock,
  isBackupInProgress,
  checkBackupRate,
  InvalidFilenameError,
  BackupNotFoundError,
  _resetForTests,
};
