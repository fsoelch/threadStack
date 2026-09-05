'use strict';
// HTTP-Schicht für Ansprechpartner (Kontakte), Rubriken und Infoblöcke
// (Arbeitspaket B1).
//
// Alles wird von AUSSEN injiziert (Dependency Injection) - dieses Modul
// importiert NICHTS aus server.js. `db`, `requireAuth`, `now` und
// `onContactDeleted` werden SPÄTER von B4 beim Wiring bereitgestellt.
const express = require('express');

const { createRateLimiter } = require('../rate-limit');
const { sendError: errorResponse, makeInternalErrorHandler } = require('../http');
const { sanitizeProgressHtml, progressPlainText, MAX_PROGRESS_HTML, MAX_PROGRESS_TEXT } = require('../progress/sanitize');
const { validateContactFields } = require('./validate');
const {
  MAX_CATEGORY_LABEL, MAX_CATEGORIES_PER_USER, MAX_INFO_BLOCKS_PER_CONTACT,
  FALLBACK_CATEGORY_LABEL, RESPONSIBILITY_CATEGORY_LABEL, normalizeLabel, toIso,
  countCategories, ensureDefaultCategories, getCategoryByLabelNorm, getFallbackCategory, getCategory,
  listCategories, insertCategory, updateCategoryLabel, reassignBlocksToCategory, deleteCategory,
  usageCounts, serializeCategory,
  countInfoBlocks, nextBlockSortOrder, listInfoBlocksForContact, getInfoBlockRow, getLegacyBlock,
  insertInfoBlock, updateInfoBlockRow, deleteInfoBlockRow, reorderInfoBlocks, serializeInfoBlockRow,
  batchContactExtras,
  listContactsForUser, getContactRow, insertContact, updateContactFields, nextContactSortOrder,
  reorderContacts, deleteContactTx, getThemeLinksForContact,
} = require('./queries');

const RESPONSIBILITY_LABEL_NORM = normalizeLabel(RESPONSIBILITY_CATEGORY_LABEL);
const FALLBACK_LABEL_NORM = normalizeLabel(FALLBACK_CATEGORY_LABEL);

const internalError = makeInternalErrorHandler('contacts', {
  code: 'internal',
  message: 'Unerwarteter Fehler. Bitte erneut versuchen.',
});

function serializeCategoryWithUsage(db, row) {
  const usage = usageCounts(db, [row.id]).get(row.id) || 0;
  return serializeCategory(row, usage);
}

function serializeContact(row, extras) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    email: row.email,
    description: extras.descriptionByContact.get(row.id) || '',
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    categories: extras.categoriesByContact.get(row.id) || [],
    infoBlockCount: extras.countByContact.get(row.id) || 0,
    snippet: extras.snippetByContact.get(row.id) || '',
  };
}

// Prüft/normalisiert den `body`-Rohwert eines Infoblocks (POST/PUT
// Infoblöcke sowie der Legacy-`description`-Shim) - IDENTISCHE Validierung
// an allen drei Stellen (Validierungsparität).
function planBody(raw) {
  const rawStr = typeof raw === 'string' ? raw : '';
  if (rawStr.length > MAX_PROGRESS_HTML) {
    return {
      error: true, code: 'body_too_long',
      message: `Der Inhalt darf maximal ${MAX_PROGRESS_HTML} Zeichen (Rohformat) haben.`,
    };
  }
  const bodyHtml = sanitizeProgressHtml(rawStr);
  const bodyText = progressPlainText(bodyHtml);
  if (bodyText.length > MAX_PROGRESS_TEXT) {
    return {
      error: true, code: 'body_too_long',
      message: `Der Inhalt darf maximal ${MAX_PROGRESS_TEXT} Zeichen haben.`,
    };
  }
  return { error: false, bodyHtml, bodyText };
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {import('express').RequestHandler} deps.requireAuth
 * @param {() => Date} [deps.now]
 * @param {(userId: string, contactId: string) => void} [deps.onContactDeleted]
 *   Wird NACH erfolgreichem Löschen eines Kontakts aufgerufen (Default:
 *   No-Op). B4 verdrahtet hier später das Aufräumen von Notizen/
 *   Zuständigkeiten aus den parallelen Arbeitspaketen. Wird defensiv in
 *   try/catch aufgerufen - ein Fehler dort darf die bereits erfolgreiche
 *   Löschantwort nicht kippen.
 * @returns {import('express').Router}
 */
function createContactsRouter({ db, requireAuth, now = () => new Date(), onContactDeleted } = {}) {
  if (!db) throw new Error('createContactsRouter: db ist erforderlich');
  if (typeof requireAuth !== 'function') throw new Error('createContactsRouter: requireAuth ist erforderlich');
  const deletedHook = typeof onContactDeleted === 'function' ? onContactDeleted : () => {};

  const router = express.Router();

  const writeLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 60,
    key: (req) => req.session && req.session.uid,
    message: 'Zu viele Änderungen. Bitte kurz warten.',
    code: 'rate_limited',
  });

  function nowIso() {
    return toIso(now);
  }

  // Liefert die Auffangrubrik "Sonstiges" - legt sie NEU an, falls sie
  // (entgegen der Erwartung, z.B. durch einen inzwischen behobenen Bug oder
  // einen manuell verfälschten Datenbestand) fehlt. `ensureDefaultCategories`
  // allein reicht dafür NICHT: es ist ein No-Op, sobald der Nutzer
  // IRGENDEINE Rubrik besitzt (siehe Vertrag), legt "Sonstiges" also nicht
  // gezielt nach. Gürtel-und-Hosenträger gegen Code-Review-Fund "Kritisch #1".
  function getOrCreateFallbackCategory(uid, iso) {
    const existing = getFallbackCategory(db, uid);
    if (existing) return existing;
    return insertCategory(db, { userId: uid, label: FALLBACK_CATEGORY_LABEL, sortOrder: 3, isDefault: 1, now: iso });
  }

  // Löst `req.params.contactId` auf, prüft Existenz UND Owner - identische
  // 404-Antwort für "existiert nicht" und "fremder Owner" (keine
  // Existenz-Enumeration). Schreibt bei Fehlschlag direkt die Response und
  // gibt null zurück.
  function resolveContact(req, res) {
    const uid = req.session.uid;
    const contactId = req.params.contactId;
    const contact = getContactRow(db, uid, contactId);
    if (!contact) {
      errorResponse(res, 404, 'contact_not_found', 'Ansprechpartner nicht gefunden.');
      return null;
    }
    return { uid, contactId, contact };
  }

  // ── Legacy-`description`-Shim (Contact-CRUD) ──────────────────
  // Schlüssel `description` NICHT im Body -> keine Blockänderung. Enthalten
  // und nicht leer -> Legacy-Block anlegen/aktualisieren (Rubrik
  // "Zuständigkeit"). Enthalten und leer -> Legacy-Block löschen.
  function planDescription(body) {
    if (!Object.prototype.hasOwnProperty.call(body, 'description')) return { action: 'none' };
    const planned = planBody(body.description);
    if (planned.error) return { action: 'error', code: planned.code, message: planned.message };
    if (!planned.bodyText) return { action: 'clear' };
    return { action: 'set', bodyHtml: planned.bodyHtml, bodyText: planned.bodyText };
  }

  function applyDescriptionPlan(uid, contactId, plan, iso) {
    if (plan.action === 'none') return;
    const legacy = getLegacyBlock(db, { userId: uid, contactId });
    if (plan.action === 'clear') {
      if (legacy) deleteInfoBlockRow(db, { userId: uid, contactId, blockId: legacy.id });
      return;
    }
    if (legacy) {
      updateInfoBlockRow(db, {
        userId: uid, contactId, blockId: legacy.id, categoryId: legacy.category_id,
        bodyHtml: plan.bodyHtml, bodyText: plan.bodyText, sortOrder: legacy.sort_order, updatedAt: iso,
      });
      return;
    }
    ensureDefaultCategories(db, uid, iso);
    // Defensiv wie migrate-description.js: wurde die Rubrik "Zuständigkeit"
    // umbenannt (siehe Code-Review-Fund "Kritisch #2"), existiert sie unter
    // diesem Label nicht mehr - auf die Auffangrubrik "Sonstiges" ausweichen,
    // statt `undefined.id` zu dereferenzieren (500).
    const category = getCategoryByLabelNorm(db, uid, RESPONSIBILITY_LABEL_NORM) || getOrCreateFallbackCategory(uid, iso);
    const sortOrder = nextBlockSortOrder(db, contactId, category.id);
    insertInfoBlock(db, {
      userId: uid, contactId, categoryId: category.id, bodyHtml: plan.bodyHtml, bodyText: plan.bodyText,
      sortOrder, isLegacyDescription: true, createdAt: iso, updatedAt: iso,
    });
  }

  // ── Kontakte (contacts) ──────────────────────────────────────

  router.get('/contacts', requireAuth, (req, res) => {
    try {
      const uid = req.session.uid;
      const rows = listContactsForUser(db, uid);
      const extras = batchContactExtras(db, rows.map((r) => r.id));
      res.json(rows.map((r) => serializeContact(r, extras)));
    } catch (err) {
      internalError(res, 'GET /contacts', err);
    }
  });

  router.post('/contacts', requireAuth, writeLimiter, (req, res) => {
    try {
      const uid = req.session.uid;
      const body = req.body || {};
      const validation = validateContactFields(body);
      if (!validation.ok) return errorResponse(res, 400, validation.code, validation.message);

      const plan = planDescription(body);
      if (plan.action === 'error') return errorResponse(res, 400, plan.code, plan.message);

      const iso = nowIso();
      const { name, role, email } = validation.values;
      const sortOrder = nextContactSortOrder(db, uid);

      let contactId;
      const run = db.transaction(() => {
        const row = insertContact(db, { userId: uid, name, role, email, sortOrder, createdAt: iso, updatedAt: iso });
        contactId = row.id;
        applyDescriptionPlan(uid, contactId, plan, iso);
      });
      run();

      const finalRow = getContactRow(db, uid, contactId);
      const extras = batchContactExtras(db, [contactId]);
      res.status(201).json(serializeContact(finalRow, extras));
    } catch (err) {
      internalError(res, 'POST /contacts', err);
    }
  });

  // Muss VOR PUT /contacts/:contactId registriert werden, sonst matcht
  // Express "reorder" fälschlich als :contactId.
  router.put('/contacts/reorder', requireAuth, writeLimiter, (req, res) => {
    try {
      const uid = req.session.uid;
      const ids = Array.isArray(req.body && req.body.ids)
        ? req.body.ids.filter((id) => typeof id === 'string')
        : [];
      reorderContacts(db, uid, ids);
      res.json({ ok: true });
    } catch (err) {
      internalError(res, 'PUT /contacts/reorder', err);
    }
  });

  router.get('/contacts/:contactId', requireAuth, (req, res) => {
    try {
      const uid = req.session.uid;
      ensureDefaultCategories(db, uid, nowIso());
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, contact } = resolved;

      const extras = batchContactExtras(db, [contactId]);
      const infoBlocks = listInfoBlocksForContact(db, contactId);
      const categories = listCategories(db, uid);
      const themeLinks = getThemeLinksForContact(db, contactId).map((r) => ({
        linkId: r.link_id, themeId: r.theme_id, themeTitle: r.theme_title,
      }));

      res.json({ contact: serializeContact(contact, extras), infoBlocks, categories, themeLinks });
    } catch (err) {
      internalError(res, 'GET /contacts/:contactId', err);
    }
  });

  router.put('/contacts/:contactId', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, uid, contact } = resolved;

      const body = req.body || {};
      // Teil-Update-Konvention (analog meetings/:id, todos/:id, knowledge/:id):
      // nicht mitgeschickte Felder bleiben unverändert (Bestandswert als
      // Default), statt sie stillschweigend zu leeren (Code-Review-Fund
      // "Hoch #3").
      const hasField = (key) => Object.prototype.hasOwnProperty.call(body, key);
      const validation = validateContactFields({
        name: hasField('name') ? body.name : contact.name,
        role: hasField('role') ? body.role : contact.role,
        email: hasField('email') ? body.email : contact.email,
      });
      if (!validation.ok) return errorResponse(res, 400, validation.code, validation.message);

      const plan = planDescription(body);
      if (plan.action === 'error') return errorResponse(res, 400, plan.code, plan.message);

      const iso = nowIso();
      const { name, role, email } = validation.values;
      const run = db.transaction(() => {
        updateContactFields(db, { userId: uid, contactId, name, role, email, updatedAt: iso });
        applyDescriptionPlan(uid, contactId, plan, iso);
      });
      run();

      const finalRow = getContactRow(db, uid, contactId);
      const extras = batchContactExtras(db, [contactId]);
      res.json(serializeContact(finalRow, extras));
    } catch (err) {
      internalError(res, 'PUT /contacts/:contactId', err);
    }
  });

  router.delete('/contacts/:contactId', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, uid } = resolved;
      const ok = deleteContactTx(db, { userId: uid, contactId });
      if (!ok) return errorResponse(res, 404, 'contact_not_found', 'Ansprechpartner nicht gefunden.');
      try { deletedHook(uid, contactId); } catch (_) { /* Hook darf die Antwort nicht kippen */ }
      res.json({ ok: true });
    } catch (err) {
      internalError(res, 'DELETE /contacts/:contactId', err);
    }
  });

  // ── Rubriken (contact-categories) ─────────────────────────────

  router.get('/contact-categories', requireAuth, (req, res) => {
    try {
      const uid = req.session.uid;
      ensureDefaultCategories(db, uid, nowIso());
      res.json({ categories: listCategories(db, uid) });
    } catch (err) {
      internalError(res, 'GET /contact-categories', err);
    }
  });

  router.post('/contact-categories', requireAuth, writeLimiter, (req, res) => {
    try {
      const uid = req.session.uid;
      ensureDefaultCategories(db, uid, nowIso());

      const raw = req.body && typeof req.body.label === 'string' ? req.body.label : '';
      const label = raw.trim();
      if (!label) return errorResponse(res, 400, 'label_required', 'Die Bezeichnung darf nicht leer sein.');
      if (label.length > MAX_CATEGORY_LABEL) {
        return errorResponse(res, 400, 'label_too_long', 'Die Bezeichnung darf maximal 100 Zeichen haben.');
      }

      const existing = getCategoryByLabelNorm(db, uid, normalizeLabel(label));
      if (existing) {
        return errorResponse(res, 409, 'category_exists', 'Diese Rubrik gibt es bereits.', {
          category: serializeCategoryWithUsage(db, existing),
        });
      }
      if (countCategories(db, uid) >= MAX_CATEGORIES_PER_USER) {
        return errorResponse(res, 400, 'category_limit_reached', 'Es sind maximal 100 Rubriken möglich.');
      }

      // `sort_order` ist NUR für die vier Default-Rubriken anzeigerelevant
      // (feste Reihenfolge 0..3) - eigene Rubriken werden immer alphabetisch
      // über `label` angezeigt (siehe listCategories()/Vertrag). Ein
      // konstanter Wert für alle eigenen Rubriken stellt sicher, dass die
      // ORDER-BY-Tiebreak-Spalte `sort_order` niemals die alphabetische
      // Sortierung eigener Rubriken verfälscht.
      const created = insertCategory(db, { userId: uid, label, sortOrder: 0, isDefault: 0, now: nowIso() });
      res.status(201).json({ category: serializeCategoryWithUsage(db, created) });
    } catch (err) {
      internalError(res, 'POST /contact-categories', err);
    }
  });

  router.put('/contact-categories/:categoryId', requireAuth, writeLimiter, (req, res) => {
    try {
      const uid = req.session.uid;
      const categoryId = req.params.categoryId;
      const existingCategory = getCategory(db, uid, categoryId);
      if (!existingCategory) return errorResponse(res, 404, 'category_not_found', 'Rubrik nicht gefunden.');
      // Die Auffangrubrik "Sonstiges" darf nicht umbenannt werden - sonst
      // würde der Fallback-Mechanismus beim Löschen anderer Rubriken sie
      // nicht mehr als solche erkennen (Code-Review-Fund "Kritisch #1").
      if (existingCategory.label_norm === FALLBACK_LABEL_NORM) {
        return errorResponse(res, 409, 'category_fallback_protected',
          'Die Rubrik „Sonstiges“ ist eine Systemrubrik und kann nicht umbenannt werden.');
      }

      const raw = req.body && typeof req.body.label === 'string' ? req.body.label : '';
      const label = raw.trim();
      if (!label) return errorResponse(res, 400, 'label_required', 'Die Bezeichnung darf nicht leer sein.');
      if (label.length > MAX_CATEGORY_LABEL) {
        return errorResponse(res, 400, 'label_too_long', 'Die Bezeichnung darf maximal 100 Zeichen haben.');
      }

      const dup = getCategoryByLabelNorm(db, uid, normalizeLabel(label));
      if (dup && dup.id !== categoryId) {
        return errorResponse(res, 409, 'category_exists', 'Diese Rubrik gibt es bereits.', {
          category: serializeCategoryWithUsage(db, dup),
        });
      }

      const updated = updateCategoryLabel(db, { userId: uid, categoryId, label, now: nowIso() });
      if (!updated) return errorResponse(res, 404, 'category_not_found', 'Rubrik nicht gefunden.');
      res.json({ category: serializeCategoryWithUsage(db, updated) });
    } catch (err) {
      internalError(res, 'PUT /contact-categories/:categoryId', err);
    }
  });

  router.delete('/contact-categories/:categoryId', requireAuth, writeLimiter, (req, res) => {
    try {
      const uid = req.session.uid;
      const categoryId = req.params.categoryId;
      const category = getCategory(db, uid, categoryId);
      if (!category) return errorResponse(res, 404, 'category_not_found', 'Rubrik nicht gefunden.');

      // Die Auffangrubrik "Sonstiges" ist an ihrer ROLLE erkennbar
      // (label_norm), NICHT an ihrer aktuellen Nutzung - sie darf NIE
      // gelöscht werden, auch wenn sie gerade unbenutzt ist. Andernfalls
      // wird `ensureDefaultCategories` zum No-Op (Nutzer hat ja noch andere
      // Rubriken) und jede nachfolgende Rubrik-Löschung mit Infoblöcken
      // crasht beim Umhängen an eine nicht mehr existierende Rubrik (500).
      // Siehe Code-Review-Fund "Kritisch #1".
      const isFallbackItself = category.label_norm === FALLBACK_LABEL_NORM;
      if (isFallbackItself) {
        return errorResponse(res, 409, 'category_fallback_protected',
          'Die Rubrik „Sonstiges“ ist eine Systemrubrik (Auffangrubrik) und kann nicht gelöscht werden.');
      }

      const usage = usageCounts(db, [categoryId]).get(categoryId) || 0;
      const confirm = req.query.confirm === 'true';

      if (!confirm && usage > 0) {
        return errorResponse(res, 409, 'category_in_use', `Diese Rubrik wird von ${usage} Infoblöcken verwendet.`, {
          usageCount: usage,
          fallbackLabel: FALLBACK_CATEGORY_LABEL,
        });
      }

      let reassignedCount = 0;
      let fallbackCategoryId = null;
      const run = db.transaction(() => {
        if (usage > 0) {
          ensureDefaultCategories(db, uid, nowIso());
          const fb = getOrCreateFallbackCategory(uid, nowIso());
          fallbackCategoryId = fb.id;
          reassignedCount = reassignBlocksToCategory(db, { fromCategoryId: categoryId, toCategoryId: fb.id });
        }
        deleteCategory(db, { userId: uid, categoryId });
      });
      run();

      res.json({ ok: true, reassignedCount, fallbackCategoryId });
    } catch (err) {
      internalError(res, 'DELETE /contact-categories/:categoryId', err);
    }
  });

  // ── Infoblöcke (contacts/:contactId/info-blocks) ──────────────

  router.get('/contacts/:contactId/info-blocks', requireAuth, (req, res) => {
    try {
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, uid } = resolved;
      res.json({ blocks: listInfoBlocksForContact(db, contactId), categories: listCategories(db, uid) });
    } catch (err) {
      internalError(res, 'GET /contacts/:contactId/info-blocks', err);
    }
  });

  router.post('/contacts/:contactId/info-blocks', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, uid } = resolved;
      ensureDefaultCategories(db, uid, nowIso());

      const body = req.body || {};
      const categoryId = typeof body.categoryId === 'string' ? body.categoryId : '';
      if (!categoryId) return errorResponse(res, 400, 'category_required', 'Bitte eine Rubrik auswählen.');
      const category = getCategory(db, uid, categoryId);
      if (!category) return errorResponse(res, 404, 'category_not_found', 'Rubrik nicht gefunden.');

      const planned = planBody(body.body);
      if (planned.error) return errorResponse(res, 400, planned.code, planned.message);
      if (!planned.bodyText) return errorResponse(res, 400, 'body_empty', 'Der Inhalt darf nicht leer sein.');

      if (countInfoBlocks(db, contactId) >= MAX_INFO_BLOCKS_PER_CONTACT) {
        return errorResponse(res, 400, 'block_limit_reached', 'Es sind maximal 50 Infoblöcke je Ansprechpartner möglich.');
      }

      const iso = nowIso();
      const sortOrder = nextBlockSortOrder(db, contactId, categoryId);
      const block = insertInfoBlock(db, {
        userId: uid, contactId, categoryId, bodyHtml: planned.bodyHtml, bodyText: planned.bodyText,
        sortOrder, isLegacyDescription: false, createdAt: iso, updatedAt: iso,
      });
      res.status(201).json({ block: serializeInfoBlockRow(block) });
    } catch (err) {
      internalError(res, 'POST /contacts/:contactId/info-blocks', err);
    }
  });

  // Muss VOR PUT .../info-blocks/:blockId registriert werden, sonst matcht
  // Express "reorder" fälschlich als :blockId.
  router.put('/contacts/:contactId/info-blocks/reorder', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, uid } = resolved;

      const body = req.body || {};
      const categoryId = typeof body.categoryId === 'string' ? body.categoryId : '';
      const category = categoryId ? getCategory(db, uid, categoryId) : null;
      if (!category) return errorResponse(res, 404, 'category_not_found', 'Rubrik nicht gefunden.');

      const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds.filter((id) => typeof id === 'string') : [];
      const blocks = reorderInfoBlocks(db, { userId: uid, contactId, categoryId, orderedIds });
      res.json({ blocks });
    } catch (err) {
      internalError(res, 'PUT /contacts/:contactId/info-blocks/reorder', err);
    }
  });

  router.put('/contacts/:contactId/info-blocks/:blockId', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, uid } = resolved;
      const blockId = req.params.blockId;
      const existing = getInfoBlockRow(db, { userId: uid, contactId, blockId });
      if (!existing) return errorResponse(res, 404, 'block_not_found', 'Infoblock nicht gefunden.');

      const body = req.body || {};
      const hasExpected = body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== null && body.expectedUpdatedAt !== '';
      if (hasExpected && String(body.expectedUpdatedAt) !== existing.updated_at) {
        return errorResponse(res, 409, 'block_conflict', 'Der Infoblock wurde zwischenzeitlich geändert.', {
          block: serializeInfoBlockRow(existing),
        });
      }

      const categoryId = typeof body.categoryId === 'string' ? body.categoryId : '';
      if (!categoryId) return errorResponse(res, 400, 'category_required', 'Bitte eine Rubrik auswählen.');
      const category = getCategory(db, uid, categoryId);
      if (!category) return errorResponse(res, 404, 'category_not_found', 'Rubrik nicht gefunden.');

      const planned = planBody(body.body);
      if (planned.error) return errorResponse(res, 400, planned.code, planned.message);
      if (!planned.bodyText) return errorResponse(res, 400, 'body_empty', 'Der Inhalt darf nicht leer sein.');

      const sameCategory = categoryId === existing.category_id;
      const sameHtml = planned.bodyHtml === existing.body_html;
      if (sameCategory && sameHtml) {
        return res.json({ block: serializeInfoBlockRow(existing) });
      }

      const iso = nowIso();
      const sortOrder = sameCategory ? existing.sort_order : nextBlockSortOrder(db, contactId, categoryId);
      const updated = updateInfoBlockRow(db, {
        userId: uid, contactId, blockId, categoryId, bodyHtml: planned.bodyHtml, bodyText: planned.bodyText,
        sortOrder, updatedAt: iso,
      });
      if (!updated) return errorResponse(res, 404, 'block_not_found', 'Infoblock nicht gefunden.');
      res.json({ block: serializeInfoBlockRow(updated) });
    } catch (err) {
      internalError(res, 'PUT /contacts/:contactId/info-blocks/:blockId', err);
    }
  });

  router.delete('/contacts/:contactId/info-blocks/:blockId', requireAuth, writeLimiter, (req, res) => {
    try {
      const resolved = resolveContact(req, res);
      if (!resolved) return;
      const { contactId, uid } = resolved;
      const blockId = req.params.blockId;
      const deleted = deleteInfoBlockRow(db, { userId: uid, contactId, blockId });
      res.json({ ok: true, deleted });
    } catch (err) {
      internalError(res, 'DELETE /contacts/:contactId/info-blocks/:blockId', err);
    }
  });

  return router;
}

module.exports = { createContactsRouter };
