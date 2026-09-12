'use strict';
// Schlanker In-Prozess-Scheduler fuer automatische DB-Backups (Arbeitspaket
// B1). Tickt stuendlich, prueft ob `backup_settings.enabled=1` und die
// aktuelle Stunde erreicht ist, und ob heute noch KEIN 'auto'-Backup
// existiert (Dedup ueber das Datum im Dateinamen). Muster 1:1 uebernommen
// von ai/jobs.js (bereits etabliert, siehe Architektur-Entscheidung) -
// inklusive 30s-Catch-up-Tick nach Prozessstart fuer waehrend eines
// Neustarts verpasste Fenster.
const { getSettings } = require('./queries');
const { createBackup, listBackups, applyRetention, withBackupLock } = require('./store');

function todayDateStr(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function tickOnce(db, { backupsDir }, now = new Date()) {
  const settings = getSettings(db);
  if (!settings.enabled) return { ran: false, reason: 'disabled' };
  if (now.getHours() !== settings.hour) return { ran: false, reason: 'wrong_hour' };

  const todayStr = todayDateStr(now);
  const alreadyRanToday = listBackups(backupsDir).some(
    (b) => b.type === 'auto' && b.createdAt.slice(0, 10).replace(/-/g, '') === todayStr
  );
  if (alreadyRanToday) return { ran: false, reason: 'already_ran' };

  try {
    await withBackupLock(async () => {
      await createBackup(db, { backupsDir, type: 'auto', now: () => now });
      applyRetention(backupsDir, settings.retentionCount);
    });
    return { ran: true };
  } catch (e) {
    // Ein einzelner fehlgeschlagener Lauf (z.B. weil manuell gerade ein
    // Backup läuft) darf den Scheduler nicht stoppen - nächster Tick greift wieder.
    console.error('[backup/scheduler] Automatisches Backup fehlgeschlagen:', e.message || e);
    return { ran: false, reason: 'error' };
  }
}

function start({ db, backupsDir }) {
  const initial = setTimeout(() => tickOnce(db, { backupsDir }).catch(() => {}), 30 * 1000);
  const hourly = setInterval(() => tickOnce(db, { backupsDir }).catch(() => {}), 60 * 60 * 1000);
  return () => { clearTimeout(initial); clearInterval(hourly); };
}

module.exports = { start, tickOnce };
