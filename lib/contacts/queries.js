'use strict';
// Datenzugriffsschicht für Ansprechpartner (Kontakte), Rubriken und
// Infoblöcke (Arbeitspaket B1).
//
// Ausschließlich parametrisierte Statements (`db.prepare(...)` mit
// `?`-Platzhaltern). IN(...)-Listen werden über generierte `?`-Platzhalter
// aus `../http` gebaut, NIEMALS über String-Konkatenation von IDs/Werten.
// Reine Datenzugriffsfunktionen - Business-Regeln (welcher Fehlercode bei
// welcher Bedingung, Transaktionsgrenzen für zusammengesetzte Abläufe)
// leben in routes.js bzw. migrate-description.js.
const { placeholders } = require('../http');
const { genId } = require('./schema');
const { truncateExcerpt } = require('../progress/sanitize');

const MAX_CATEGORY_LABEL = 100;
const MAX_CATEGORIES_PER_USER = 100;
const MAX_INFO_BLOCKS_PER_CONTACT = 50;

// Reihenfolge ist bindend (sort_order 0..3, is_default=1) - siehe Vertrag.
const DEFAULT_CATEGORY_LABELS = ['Zuständigkeit', 'Privates', 'Wichtiges', 'Sonstiges'];
const FALLBACK_CATEGORY_LABEL = 'Sonstiges';
// Einzige Quelle der Wahrheit für den Rubrik-Namen des Legacy-`description`-
// Shims (Code-Review-Fund "Mittel": vormals dreifach dupliziertes Literal in
// queries.js/routes.js/migrate-description.js).
const RESPONSIBILITY_CATEGORY_LABEL = 'Zuständigkeit';
// Einzige Quelle der Wahrheit für den Rubrik-Namen der "Privates"-Rubrik.
// Deren Inhalte dürfen NIE im aggregierten `snippet` (Karten-Textauszug)
// landen - siehe NFR-5 (Datenschutz) und Code-Review-Fund "Kritisch":
// batchContactExtras() aggregierte vormals body_text ALLER Rubriken ohne
// Rücksicht auf die Kategorie, wodurch private Texte bei gemischten
// Rubriken (z.B. "Zuständigkeit" + "Privates") auf der Kontakt-Übersichts-
// karte im Klartext sichtbar wurden.
const PRIVATE_CATEGORY_LABEL = 'Privates';
// Wird unten (nach Definition von normalizeLabel) berechnet - siehe
// PRIVATE_CATEGORY_LABEL_NORM weiter unten im Modul.

function normalizeLabel(label) {
  return String(label == null ? '' : label).trim().toLowerCase();
}

const PRIVATE_CATEGORY_LABEL_NORM = normalizeLabel(PRIVATE_CATEGORY_LABEL);

// Akzeptiert sowohl eine Zeitquelle-Funktion (`() => Date`, Projektkonvention
// analog lib/progress) als auch bereits einen ISO-String/eine Date-Instanz -
// robust gegenüber beiden Aufrufkonventionen im Vertrag.
function toIso(now) {
  if (typeof now === 'function') {
    const v = now();
    return v instanceof Date ? v.toISOString() : String(v);
  }
  if (now instanceof Date) return now.toISOString();
  if (typeof now === 'string' && now) return now;
  return new Date().toISOString();
}

// ── Rubriken (contact_categories) ──────────────────────────────

function countCategories(db, userId) {
  return db.prepare('SELECT COUNT(*) as c FROM contact_categories WHERE user_id=?').get(userId).c;
}

/**
 * Legt bei einem Nutzer OHNE jegliche vorhandene Rubrik die vier
 * Standardrubriken an ("Zuständigkeit","Privates","Wichtiges","Sonstiges",
 * sort_order 0..3, is_default=1). Idempotent - bereits vorhandene Rubriken
 * (gleich welche) verhindern jede weitere Anlage.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {(() => Date) | string | Date} [now]
 */
function ensureDefaultCategories(db, userId, now) {
  if (countCategories(db, userId) > 0) return;
  const iso = toIso(now);
  const insert = db.prepare(
    `INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,1,?,?,?)`
  );
  const run = db.transaction(() => {
    DEFAULT_CATEGORY_LABELS.forEach((label, i) => {
      insert.run(genId(), userId, label, normalizeLabel(label), i, iso, iso);
    });
  });
  run();
}

function getCategoryByLabelNorm(db, userId, labelNorm) {
  return db.prepare('SELECT * FROM contact_categories WHERE user_id=? AND label_norm=?').get(userId, labelNorm);
}

function getFallbackCategory(db, userId) {
  return getCategoryByLabelNorm(db, userId, normalizeLabel(FALLBACK_CATEGORY_LABEL));
}

/**
 * Liefert die Auffangrubrik "Sonstiges" eines Nutzers - legt sie NEU an,
 * falls sie (entgegen der Erwartung, z.B. weil sie umbenannt wurde oder der
 * Datenbestand manuell verändert wurde) fehlt. `ensureDefaultCategories`
 * allein reicht dafür NICHT: es ist ein No-Op, sobald der Nutzer IRGENDEINE
 * Rubrik besitzt (siehe Vertrag), legt "Sonstiges" also nicht gezielt nach.
 * Gürtel-und-Hosenträger gegen Code-Review-Fund "Kritisch #1".
 *
 * Einzige Implementierung dieses Fallbacks im gesamten Modul - sowohl
 * `routes.js` als auch `migrate-description.js` verwenden AUSSCHLIESSLICH
 * diese Funktion, damit beide Pfade (Kontakt-CRUD und Migration) identisch
 * auf eine fehlende "Zuständigkeit"-Rubrik reagieren (Code-Review-Fund
 * "Mittel": vormals zwei divergierende Varianten, wodurch die Migration
 * Kontakte übersprang statt sie in die Auffangrubrik zu migrieren).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {(() => Date) | string | Date} [now]
 */
function getOrCreateFallbackCategory(db, userId, now) {
  const existing = getFallbackCategory(db, userId);
  if (existing) return existing;
  const sortOrder = DEFAULT_CATEGORY_LABELS.indexOf(FALLBACK_CATEGORY_LABEL);
  return insertCategory(db, {
    userId,
    label: FALLBACK_CATEGORY_LABEL,
    sortOrder: sortOrder >= 0 ? sortOrder : 0,
    isDefault: 1,
    now,
  });
}

function getCategory(db, userId, categoryId) {
  return db.prepare('SELECT * FROM contact_categories WHERE id=? AND user_id=?').get(categoryId, userId);
}

function usageCounts(db, categoryIds) {
  const map = new Map();
  if (!categoryIds.length) return map;
  const rows = db.prepare(
    `SELECT category_id, COUNT(*) as cnt FROM contact_info_blocks WHERE category_id IN (${placeholders(categoryIds.length)}) GROUP BY category_id`
  ).all(...categoryIds);
  for (const r of rows) map.set(r.category_id, r.cnt);
  return map;
}

function serializeCategory(row, usageCount) {
  return {
    id: row.id,
    label: row.label,
    isDefault: !!row.is_default,
    sortOrder: row.sort_order,
    usageCount: usageCount || 0,
  };
}

/**
 * Liest alle Rubriken eines Nutzers in Anzeige-Reihenfolge: Default-Rubriken
 * zuerst (feste sort_order 0..3), danach eigene Rubriken alphabetisch
 * (COLLATE NOCASE über `label`, unabhängig von der Anlage-Reihenfolge).
 */
function listCategories(db, userId) {
  const rows = db.prepare(
    `SELECT * FROM contact_categories WHERE user_id=? ORDER BY is_default DESC, sort_order ASC, label COLLATE NOCASE ASC`
  ).all(userId);
  if (!rows.length) return [];
  const counts = usageCounts(db, rows.map((r) => r.id));
  return rows.map((r) => serializeCategory(r, counts.get(r.id)));
}

function insertCategory(db, { userId, label, sortOrder, isDefault = 0, now }) {
  const iso = toIso(now);
  const id = genId();
  db.prepare(
    `INSERT INTO contact_categories(id,user_id,label,label_norm,is_default,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, userId, label, normalizeLabel(label), isDefault ? 1 : 0, sortOrder, iso, iso);
  return getCategory(db, userId, id);
}

function updateCategoryLabel(db, { userId, categoryId, label, now }) {
  const iso = toIso(now);
  const info = db.prepare(
    `UPDATE contact_categories SET label=?, label_norm=?, updated_at=? WHERE id=? AND user_id=?`
  ).run(label, normalizeLabel(label), iso, categoryId, userId);
  if (!info.changes) return null;
  return getCategory(db, userId, categoryId);
}

/**
 * Verschiebt ALLE Infoblöcke einer Rubrik ans Ende einer anderen Rubrik
 * (neue, fortlaufende `sort_order`-Werte), OHNE dabei den Kontaktbezug zu
 * verändern - reine Rubrik-Umhängung. Muss vom Aufrufer in einer Transaktion
 * VOR dem Löschen der Quellrubrik ausgeführt werden (FK ist ON DELETE
 * RESTRICT).
 * @returns {number} Anzahl umgehängter Infoblöcke.
 */
function reassignBlocksToCategory(db, { fromCategoryId, toCategoryId }) {
  const blocks = db.prepare(
    `SELECT id, contact_id FROM contact_info_blocks WHERE category_id=? ORDER BY sort_order ASC, created_at ASC, id ASC`
  ).all(fromCategoryId);
  if (!blocks.length) return 0;
  // Sort_order muss PRO KONTAKT innerhalb der Zielrubrik fortlaufend sein
  // (siehe idx_cib_contact) - daher je Kontakt einzeln ans Ende anhängen.
  const maxByContact = new Map();
  const nextFor = db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) as m FROM contact_info_blocks WHERE contact_id=? AND category_id=?`
  );
  const update = db.prepare('UPDATE contact_info_blocks SET category_id=?, sort_order=? WHERE id=?');
  for (const b of blocks) {
    if (!maxByContact.has(b.contact_id)) {
      maxByContact.set(b.contact_id, nextFor.get(b.contact_id, toCategoryId).m);
    }
    const next = maxByContact.get(b.contact_id) + 1;
    maxByContact.set(b.contact_id, next);
    update.run(toCategoryId, next, b.id);
  }
  return blocks.length;
}

function deleteCategory(db, { userId, categoryId }) {
  const info = db.prepare('DELETE FROM contact_categories WHERE id=? AND user_id=?').run(categoryId, userId);
  return info.changes > 0;
}

// ── Infoblöcke (contact_info_blocks) ───────────────────────────

function countInfoBlocks(db, contactId) {
  return db.prepare('SELECT COUNT(*) as c FROM contact_info_blocks WHERE contact_id=?').get(contactId).c;
}

function nextBlockSortOrder(db, contactId, categoryId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) as m FROM contact_info_blocks WHERE contact_id=? AND category_id=?'
  ).get(contactId, categoryId);
  return row.m + 1;
}

function serializeInfoBlockRow(row) {
  return {
    id: row.id,
    contactId: row.contact_id,
    categoryId: row.category_id,
    categoryLabel: row.category_label,
    bodyHtml: row.body_html,
    excerpt: truncateExcerpt(row.body_text, 280),
    sortOrder: row.sort_order,
    isLegacyDescription: !!row.is_legacy_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BLOCK_ORDER_JOIN_SQL = `
  FROM contact_info_blocks b
  JOIN contact_categories c ON c.id = b.category_id
`;
const BLOCK_ORDER_BY_SQL = `
  ORDER BY c.is_default DESC, c.sort_order ASC, c.label COLLATE NOCASE ASC, b.sort_order ASC, b.created_at ASC, b.id ASC
`;

function listInfoBlocksForContact(db, contactId) {
  const rows = db.prepare(
    `SELECT b.*, c.label as category_label ${BLOCK_ORDER_JOIN_SQL} WHERE b.contact_id=? ${BLOCK_ORDER_BY_SQL}`
  ).all(contactId);
  return rows.map(serializeInfoBlockRow);
}

function getInfoBlockRow(db, { userId, contactId, blockId }) {
  return db.prepare(
    `SELECT b.*, c.label as category_label ${BLOCK_ORDER_JOIN_SQL}
     WHERE b.id=? AND b.contact_id=? AND b.user_id=?`
  ).get(blockId, contactId, userId);
}

function getLegacyBlock(db, { userId, contactId }) {
  return db.prepare(
    `SELECT b.*, c.label as category_label ${BLOCK_ORDER_JOIN_SQL}
     WHERE b.contact_id=? AND b.user_id=? AND b.is_legacy_description=1`
  ).get(contactId, userId);
}

function insertInfoBlock(db, { userId, contactId, categoryId, bodyHtml, bodyText, sortOrder, isLegacyDescription = false, createdAt, updatedAt }) {
  const id = genId();
  db.prepare(
    `INSERT INTO contact_info_blocks(id,user_id,contact_id,category_id,body_html,body_text,sort_order,is_legacy_description,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, userId, contactId, categoryId, bodyHtml, bodyText, sortOrder, isLegacyDescription ? 1 : 0, createdAt, updatedAt);
  return getInfoBlockRow(db, { userId, contactId, blockId: id });
}

function updateInfoBlockRow(db, { userId, contactId, blockId, categoryId, bodyHtml, bodyText, sortOrder, updatedAt }) {
  const info = db.prepare(
    `UPDATE contact_info_blocks SET category_id=?, body_html=?, body_text=?, sort_order=?, updated_at=?
     WHERE id=? AND contact_id=? AND user_id=?`
  ).run(categoryId, bodyHtml, bodyText, sortOrder, updatedAt, blockId, contactId, userId);
  if (!info.changes) return null;
  return getInfoBlockRow(db, { userId, contactId, blockId });
}

function deleteInfoBlockRow(db, { userId, contactId, blockId }) {
  const info = db.prepare(
    'DELETE FROM contact_info_blocks WHERE id=? AND contact_id=? AND user_id=?'
  ).run(blockId, contactId, userId);
  return info.changes > 0;
}

/**
 * Schreibt Positionen 0..n-1 NUR für Blöcke, die tatsächlich zu
 * `contactId`+`categoryId` gehören (unbekannte/fremde IDs werden ignoriert).
 * Nicht in `orderedIds` genannte Blöcke der Rubrik werden stabil (nach
 * bisheriger Reihenfolge) ans Ende gehängt. Läuft in EINER Transaktion.
 * @returns {InfoBlock[]} die Blöcke der Rubrik in der neuen Reihenfolge (roh, ohne Serialisierung).
 */
function reorderInfoBlocks(db, { userId, contactId, categoryId, orderedIds }) {
  const run = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM contact_info_blocks WHERE contact_id=? AND category_id=? AND user_id=? ORDER BY sort_order ASC, created_at ASC, id ASC'
    ).all(contactId, categoryId, userId).map((r) => r.id);
    const existingSet = new Set(existing);
    const wanted = orderedIds.filter((id) => existingSet.has(id));
    const wantedSet = new Set(wanted);
    const remainder = existing.filter((id) => !wantedSet.has(id));
    const finalOrder = [...wanted, ...remainder];
    const update = db.prepare('UPDATE contact_info_blocks SET sort_order=? WHERE id=?');
    finalOrder.forEach((id, i) => update.run(i, id));
  });
  run();
  return listInfoBlocksForContact(db, contactId).filter((b) => b.categoryId === categoryId);
}

// ── Batch-Anreicherung für Contact-Listen (kein N+1) ───────────

/**
 * Liefert für eine Menge von Kontakt-IDs in GENAU ZWEI Batch-Queries:
 * - `categoriesByContact`: je Kontakt die distinct genutzten Rubriken
 *   ({id,label}), in Anzeige-Reihenfolge.
 * - `countByContact`: Anzahl Infoblöcke je Kontakt.
 * - `snippetByContact`: konkatenierter Klartext-Auszug (280 Zeichen) in
 *   Anzeige-Reihenfolge.
 * - `descriptionByContact`: `body_html` des Legacy-Blocks (is_legacy_description=1),
 *   falls vorhanden (Legacy-`description`-Shim).
 */
function batchContactExtras(db, contactIds) {
  const result = {
    categoriesByContact: new Map(),
    countByContact: new Map(),
    snippetByContact: new Map(),
    descriptionByContact: new Map(),
  };
  if (!contactIds.length) return result;
  const ph = placeholders(contactIds.length);

  // Query 1: distinct genutzte Rubriken je Kontakt.
  const catRows = db.prepare(`
    SELECT DISTINCT b.contact_id as contact_id, c.id as category_id, c.label as label,
           c.is_default as is_default, c.sort_order as category_sort_order
    FROM contact_info_blocks b
    JOIN contact_categories c ON c.id = b.category_id
    WHERE b.contact_id IN (${ph})
    ORDER BY b.contact_id, c.is_default DESC, c.sort_order ASC, c.label COLLATE NOCASE ASC
  `).all(...contactIds);
  for (const r of catRows) {
    if (!result.categoriesByContact.has(r.contact_id)) result.categoriesByContact.set(r.contact_id, []);
    result.categoriesByContact.get(r.contact_id).push({ id: r.category_id, label: r.label });
  }

  // Query 2: alle Infoblöcke (Anzeige-Reihenfolge) je Kontakt - liefert
  // Anzahl, Snippet-Rohtext UND den Legacy-Block in einem Rutsch. `label_norm`
  // wird zusätzlich mitgeliefert, damit die "Privates"-Rubrik gezielt aus der
  // Snippet-Aggregation ausgeschlossen werden kann (Code-Review-Fund
  // "Kritisch" / NFR-5) - Anzahl (`countByContact`) und Rubrik-Badges
  // (`categoriesByContact`, siehe Query 1) bleiben davon UNBERÜHRT, private
  // Infoblöcke zählen weiterhin mit und ihre Rubrik erscheint weiterhin als
  // Badge, nur der Klartext fließt nicht in den Kartenauszug ein.
  const blockRows = db.prepare(`
    SELECT b.contact_id as contact_id, b.body_text as body_text, b.body_html as body_html,
           b.is_legacy_description as is_legacy_description, c.label_norm as category_label_norm
    ${BLOCK_ORDER_JOIN_SQL}
    WHERE b.contact_id IN (${ph})
    ${BLOCK_ORDER_BY_SQL}
  `).all(...contactIds);
  const textsByContact = new Map();
  for (const r of blockRows) {
    result.countByContact.set(r.contact_id, (result.countByContact.get(r.contact_id) || 0) + 1);
    const isPrivate = r.category_label_norm === PRIVATE_CATEGORY_LABEL_NORM;
    if (!isPrivate) {
      if (!textsByContact.has(r.contact_id)) textsByContact.set(r.contact_id, []);
      if (r.body_text) textsByContact.get(r.contact_id).push(r.body_text);
    }
    if (r.is_legacy_description) result.descriptionByContact.set(r.contact_id, r.body_html || '');
  }
  for (const [cid, texts] of textsByContact) {
    result.snippetByContact.set(cid, truncateExcerpt(texts.join(' '), 280));
  }

  return result;
}

// ── Kontakte (contacts) ─────────────────────────────────────────

function listContactsForUser(db, userId) {
  return db.prepare('SELECT * FROM contacts WHERE user_id=? ORDER BY sort_order ASC, created_at ASC').all(userId);
}

function getContactRow(db, userId, contactId) {
  return db.prepare('SELECT * FROM contacts WHERE id=? AND user_id=?').get(contactId, userId);
}

function insertContact(db, { userId, name, role, email, sortOrder, createdAt, updatedAt }) {
  const id = genId();
  db.prepare(
    `INSERT INTO contacts(id,user_id,name,role,email,description,sort_order,created_at,updated_at)
     VALUES (?,?,?,?,?,'',?,?,?)`
  ).run(id, userId, name, role, email, sortOrder, createdAt, updatedAt);
  return getContactRow(db, userId, id);
}

function updateContactFields(db, { userId, contactId, name, role, email, updatedAt }) {
  const info = db.prepare(
    'UPDATE contacts SET name=?, role=?, email=?, updated_at=? WHERE id=? AND user_id=?'
  ).run(name, role, email, updatedAt, contactId, userId);
  return info.changes > 0;
}

function nextContactSortOrder(db, userId) {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM contacts WHERE user_id=?').get(userId);
  return row.m + 1;
}

function reorderContacts(db, userId, ids) {
  const update = db.prepare('UPDATE contacts SET sort_order=? WHERE id=? AND user_id=?');
  const run = db.transaction(() => {
    ids.forEach((id, i) => update.run(i, id, userId));
  });
  run();
}

/**
 * Löscht einen Kontakt in EINER Transaktion: `theme_links` mit
 * ref_type='contact' für diesen Kontakt, danach der Kontakt selbst
 * (Infoblöcke folgen per FK-Cascade). Gibt `true` zurück, wenn der Kontakt
 * existierte und dem Nutzer gehörte.
 */
function deleteContactTx(db, { userId, contactId }) {
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM theme_links WHERE ref_type='contact' AND ref_id=?`).run(contactId);
    return db.prepare('DELETE FROM contacts WHERE id=? AND user_id=?').run(contactId, userId).changes > 0;
  });
  return run();
}

function getThemeLinksForContact(db, contactId) {
  return db.prepare(
    `SELECT tl.id as link_id, tl.theme_id as theme_id, th.title as theme_title
     FROM theme_links tl JOIN themes th ON th.id = tl.theme_id
     WHERE tl.ref_type='contact' AND tl.ref_id=?`
  ).all(contactId);
}

module.exports = {
  MAX_CATEGORY_LABEL,
  MAX_CATEGORIES_PER_USER,
  MAX_INFO_BLOCKS_PER_CONTACT,
  DEFAULT_CATEGORY_LABELS,
  FALLBACK_CATEGORY_LABEL,
  RESPONSIBILITY_CATEGORY_LABEL,
  PRIVATE_CATEGORY_LABEL,
  PRIVATE_CATEGORY_LABEL_NORM,
  normalizeLabel,
  toIso,
  // Rubriken
  countCategories,
  ensureDefaultCategories,
  getCategoryByLabelNorm,
  getFallbackCategory,
  getOrCreateFallbackCategory,
  getCategory,
  listCategories,
  insertCategory,
  updateCategoryLabel,
  reassignBlocksToCategory,
  deleteCategory,
  usageCounts,
  serializeCategory,
  // Infoblöcke
  countInfoBlocks,
  nextBlockSortOrder,
  listInfoBlocksForContact,
  getInfoBlockRow,
  getLegacyBlock,
  insertInfoBlock,
  updateInfoBlockRow,
  deleteInfoBlockRow,
  reorderInfoBlocks,
  serializeInfoBlockRow,
  batchContactExtras,
  // Kontakte
  listContactsForUser,
  getContactRow,
  insertContact,
  updateContactFields,
  nextContactSortOrder,
  reorderContacts,
  deleteContactTx,
  getThemeLinksForContact,
};
