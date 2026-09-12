'use strict';
// Zugriff auf `backup_settings` (Zeitplan/Retention). Reine Funktionen auf
// `db` - kein Express, kein Import aus server.js. Analog lib/momentum/queries.js.
const { SETTINGS_ID } = require('./schema');

function toView(row) {
  return {
    enabled: !!row.enabled,
    hour: row.hour,
    retentionCount: row.retention_count,
    updatedAt: row.updated_at || null,
  };
}

function getSettings(db) {
  const row = db.prepare('SELECT * FROM backup_settings WHERE id=?').get(SETTINGS_ID);
  return toView(row);
}

const VALIDATION_ERRORS = {
  INVALID_HOUR: 'INVALID_HOUR',
  INVALID_RETENTION: 'INVALID_RETENTION',
  INVALID_ENABLED: 'INVALID_ENABLED',
};

function validateSettingsPatch(patch) {
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    return { ok: false, error: VALIDATION_ERRORS.INVALID_ENABLED };
  }
  if (patch.hour !== undefined) {
    if (!Number.isInteger(patch.hour) || patch.hour < 0 || patch.hour > 23) {
      return { ok: false, error: VALIDATION_ERRORS.INVALID_HOUR };
    }
  }
  if (patch.retentionCount !== undefined) {
    if (!Number.isInteger(patch.retentionCount) || patch.retentionCount < 1 || patch.retentionCount > 100) {
      return { ok: false, error: VALIDATION_ERRORS.INVALID_RETENTION };
    }
  }
  return { ok: true };
}

function saveSettings(db, patch, { updatedAt, updatedBy }) {
  const validated = validateSettingsPatch(patch);
  if (!validated.ok) return validated;

  const current = db.prepare('SELECT * FROM backup_settings WHERE id=?').get(SETTINGS_ID);
  const next = {
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled,
    hour: patch.hour !== undefined ? patch.hour : current.hour,
    retention_count: patch.retentionCount !== undefined ? patch.retentionCount : current.retention_count,
  };
  db.prepare(
    'UPDATE backup_settings SET enabled=?, hour=?, retention_count=?, updated_at=?, updated_by=? WHERE id=?'
  ).run(next.enabled, next.hour, next.retention_count, updatedAt, updatedBy || null, SETTINGS_ID);

  return { ok: true, settings: toView(db.prepare('SELECT * FROM backup_settings WHERE id=?').get(SETTINGS_ID)) };
}

module.exports = { getSettings, saveSettings, validateSettingsPatch, VALIDATION_ERRORS };
