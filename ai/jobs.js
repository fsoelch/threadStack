'use strict';
const ai = require('./index');

// Schlanker In-Prozess-Scheduler für Wochen-Digest (W-AI06).
// Tickt jede Stunde, prüft pro Nutzer mit weekly_digest_enabled=1, ob heute
// der konfigurierte Wochentag und die konfigurierte Stunde erreicht sind und
// für die aktuelle ISO-Woche noch kein Digest existiert.
//
// Idempotenz: weeklyDigest() deduplikiert per (user_id, ref_id=YYYY-Www).
// Robust gegen Service-Restart: ein Service-Start ruft tick() zusätzlich
// nach 30s einmalig, damit ein verpasstes Fenster nachgeholt werden kann.

function isoYearWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day  = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const isoYear  = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 4));
  const isoWeek  = 1 + Math.round(((date - yearStart) / 86400000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

async function tickOnce(db, encryptionKey, now = new Date()) {
  // Effektive Wochentag/Stunde nach Server-Localzeit (analog Bestand: keine TZ-DB).
  const dow  = now.getDay();       // 0 = Sonntag
  const hour = now.getHours();

  const candidates = db.prepare(
    `SELECT * FROM ai_settings
      WHERE weekly_digest_enabled = 1
        AND globally_disabled = 0
        AND provider != ''
        AND api_key_encrypted != ''
        AND weekly_digest_dow  = ?
        AND weekly_digest_hour <= ?`
  ).all(dow, hour);

  if (!candidates.length) return { ran: 0 };

  const week = isoYearWeek(now);
  let ran = 0;
  for (const row of candidates) {
    // Schon für diese Woche generiert?
    const existing = db.prepare(
      `SELECT id FROM ai_artifacts WHERE user_id=? AND feature='digest' AND ref_id=? LIMIT 1`
    ).get(row.user_id, week);
    if (existing) continue;

    // Feature an?
    let features = {};
    try { features = JSON.parse(row.features_enabled || '{}'); } catch { features = {}; }
    if (!features.digest) continue;

    try {
      const settings = ai.loadSettings(db, row.user_id);
      await ai.weeklyDigest({
        db, userId: row.user_id, settings, encryptionKey,
        confirmed: true,   // job läuft autonom — Bestätigung ist hier sinnlos
        force: false,      // doppelte Erzeugung in derselben Woche verhindert
      });
      ran++;
    } catch (e) {
      // Schweigend: ein einzelner Nutzer-Fehler soll den Lauf nicht stoppen.
      // Logging optional via console; bewusst kein Stack.
      console.error(`[ai/jobs] weekly digest failed for ${row.user_id}:`, e.message || e);
    }
  }
  return { ran };
}

function start({ db, encryptionKey }) {
  // 30s nach Start: Catch-up-Tick (falls Service während des Fensters neugestartet wurde)
  const initial = setTimeout(() => tickOnce(db, encryptionKey).catch(()=>{}), 30 * 1000);
  // Danach jede Stunde
  const hourly  = setInterval(() => tickOnce(db, encryptionKey).catch(()=>{}), 60 * 60 * 1000);
  return () => { clearTimeout(initial); clearInterval(hourly); };
}

module.exports = { start, tickOnce, isoYearWeek };
