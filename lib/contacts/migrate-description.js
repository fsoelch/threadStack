'use strict';
// Einmalige, verlustfreie Migration der alten `contacts.description`
// (Freitext) in einen Infoblock der Rubrik "Zuständigkeit"
// (`is_legacy_description=1`) - Arbeitspaket B1.
//
// Läuft in EINER Gesamt-Transaktion (kein teilmigrierter Bestand bei
// Fehler). Wiederholter Aufruf ist idempotent (`migrated: 0` beim zweiten
// Lauf) - zusätzlich strukturell durch den partiellen Unique-Index
// `idx_cib_legacy` (contact_id) WHERE is_legacy_description=1 abgesichert.
//
// Logging enthält AUSSCHLIESSLICH Zähler, NIEMALS Kontaktnamen/-inhalte
// (Datenschutz, siehe Sicherheits-Baseline).
const { sanitizeProgressHtml, progressPlainText } = require('../progress/sanitize');
const {
  ensureDefaultCategories,
  getCategoryByLabelNorm,
  getOrCreateFallbackCategory,
  normalizeLabel,
  insertInfoBlock,
  toIso,
  RESPONSIBILITY_CATEGORY_LABEL,
} = require('./queries');

const RESPONSIBILITY_LABEL_NORM = normalizeLabel(RESPONSIBILITY_CATEGORY_LABEL);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{now?: (() => Date) | string | Date}} [opts]
 * @returns {{migrated: number, skipped: number}}
 */
function migrateContactDescriptions(db, { now } = {}) {
  const iso = toIso(now);
  const candidates = db.prepare(`
    SELECT c.id as id, c.user_id as user_id, c.description as description, c.created_at as created_at
    FROM contacts c
    WHERE c.description <> ''
      AND NOT EXISTS (
        SELECT 1 FROM contact_info_blocks b WHERE b.contact_id = c.id AND b.is_legacy_description = 1
      )
  `).all();

  let migrated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const row of candidates) {
      ensureDefaultCategories(db, row.user_id, iso);
      // Fehlt die Rubrik "Zuständigkeit" (z.B. weil sie umbenannt wurde),
      // wird - IDENTISCH zum Kontakt-CRUD in routes.js - auf die
      // Auffangrubrik "Sonstiges" ausgewichen (`getOrCreateFallbackCategory`,
      // siehe queries.js), statt den Kontakt zu überspringen. Andernfalls
      // bliebe der alte Beschreibungstext dauerhaft unmigriert in
      // `contacts.description` stehen und wäre NIE als Infoblock sichtbar -
      // das verletzt die Story-13-Anforderung "verlustfreie Migration"
      // (Code-Review-Fund "Mittel").
      const category = getCategoryByLabelNorm(db, row.user_id, RESPONSIBILITY_LABEL_NORM)
        || getOrCreateFallbackCategory(db, row.user_id, iso);

      const bodyHtml = sanitizeProgressHtml(row.description);
      const bodyText = progressPlainText(bodyHtml);

      if (!bodyText) {
        // Rein aus Formatierung/Markup bestehende "Beschreibung" ohne
        // Klartext-Inhalt: kein Block, nur die Alt-Spalte leeren.
        db.prepare('UPDATE contacts SET description=\'\' WHERE id=?').run(row.id);
        skipped += 1;
        continue;
      }

      insertInfoBlock(db, {
        userId: row.user_id,
        contactId: row.id,
        categoryId: category.id,
        bodyHtml,
        bodyText,
        sortOrder: 0,
        isLegacyDescription: true,
        createdAt: row.created_at,
        updatedAt: iso,
      });
      db.prepare('UPDATE contacts SET description=\'\' WHERE id=?').run(row.id);
      migrated += 1;
    }
  });
  run();

  try {
    console.log('[contacts-migration]', JSON.stringify({ migrated, skipped }));
  } catch (_) { /* Logging darf niemals selbst einen Fehler werfen */ }

  return { migrated, skipped };
}

module.exports = { migrateContactDescriptions };
