'use strict';
// ISO-8601-Wochennummer ("YYYY-Www"), aus ai/index.js UND ai/jobs.js
// extrahiert, die sie zuvor wortgleich duplizierten (Arbeit zur Lesbarkeit/
// Wartbarkeit) - Verhalten unveraendert. Wird fuer die Wochen-Digest-
// Deduplizierung (ai_artifacts.ref_id) verwendet.
function isoYearWeek(d = new Date()) {
  // ISO week: Thursday determines the year.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day  = (date.getUTCDay() + 6) % 7;  // Mon=0
  date.setUTCDate(date.getUTCDate() - day + 3);
  const isoYear  = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 4));
  const isoWeek  = 1 + Math.round(((date - yearStart) / 86400000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

module.exports = { isoYearWeek };
