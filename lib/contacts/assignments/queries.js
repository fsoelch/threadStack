'use strict';
// Query-Logik für Kontakt-Zuständigkeiten (contact_assignments). Wird sowohl
// vom eigenen Router (router.js) als auch — über die in index.js exportierten
// Sammelfunktionen — von B4 (Anreicherung von GET /todos, GET /meetings)
// genutzt. Alle Zugriffe sind parametrisiert, keine String-Konkatenation von
// IDs (IN-Listen werden über generierte Platzhalter gebaut).

const crypto = require('crypto');

const MAX_ASSIGNMENTS_PER_REF = 20;
const VALID_REF_TYPES = new Set(['topic', 'todo']);

// Gemeinsame Spaltenliste für die "AssignedContact"-Projektion, damit
// listAssignedContacts / rowToAssignedContact / contactsForRefs garantiert
// dasselbe Shape liefern (Nachbesserung Code-Review Fund 7).
const ASSIGNED_CONTACT_COLUMNS = 'c.id AS contactId, c.name AS name, c.role AS role, c.email AS email';

// Ehemals in lib/contacts/assignments/http.js dupliziert (Code-Review Fund 6).
// Baut eine SQL-Platzhalterliste für IN(...)-Klauseln generierter Länge.
function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

// Einheitlicher Fehlertyp für Steuerfluss innerhalb dieses Moduls; router.js
// fängt ihn ab und übersetzt ihn über den (injizierten) Fehler-Envelope.
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function genId() {
  // Gleiches Muster wie server.js#uid(): Zeit-Präfix + Zufallssuffix.
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function assertValidRefType(refType) {
  if (!VALID_REF_TYPES.has(refType)) {
    throw new ApiError(400, 'INVALID_REF_TYPE', 'Ungültiger Typ.');
  }
}

// "Existiert nicht" und "gehört anderem Nutzer" sind für den Client immer
// ununterscheidbar (beides 404 REF_NOT_FOUND).
// (Ehemals resolveVorhaben — umbenannt für konsistente Namensgebung,
// Code-Review Fund 9/Niedrig-1.)
function assertOwnsRef(ownsRef, uid, refType, refId) {
  assertValidRefType(refType);
  if (!refId || typeof refId !== 'string' || !ownsRef(uid, refType, refId)) {
    throw new ApiError(404, 'REF_NOT_FOUND', 'Nicht gefunden.');
  }
}

function assertWritable(isRefReadOnly, refType, refId) {
  if (typeof isRefReadOnly === 'function' && isRefReadOnly(refType, refId)) {
    // Neutrale, typunabhängige Meldung (Code-Review Fund 10): gilt sowohl für
    // Topics (Meeting archiviert) als auch für ToDos.
    throw new ApiError(
      409,
      'ARCHIVED_READONLY',
      'Dieser Eintrag ist archiviert. Zum Bearbeiten bitte wiederherstellen.'
    );
  }
}

function resolveContact(db, uid, contactId) {
  if (!contactId || typeof contactId !== 'string') {
    throw new ApiError(404, 'CONTACT_NOT_FOUND', 'Ansprechpartner nicht gefunden.');
  }
  const row = db.prepare('SELECT 1 FROM contacts WHERE id=? AND user_id=?').get(contactId, uid);
  if (!row) {
    throw new ApiError(404, 'CONTACT_NOT_FOUND', 'Ansprechpartner nicht gefunden.');
  }
}

// Auf user_id skopiert (Defense-in-Depth, Code-Review Fund 5) — auch wenn die
// Eigentümerschaft des Refs vorgelagert bereits über assertOwnsRef geprüft
// wurde, filtert die Query zusätzlich konsequent auf den anfragenden Nutzer.
function listAssignedContacts(db, uid, refType, refId) {
  return db
    .prepare(
      `SELECT ${ASSIGNED_CONTACT_COLUMNS}, ca.created_at AS assignedAt
       FROM contact_assignments ca
       JOIN contacts c ON c.id = ca.contact_id
       WHERE ca.ref_type=? AND ca.ref_id=? AND ca.user_id=? AND c.user_id=?
       ORDER BY c.sort_order, c.name`
    )
    .all(refType, refId, uid, uid);
}

// Projiziert einen einzelnen (bereits über resolveContact validierten)
// Kontakt auf dasselbe AssignedContact-Shape. Kein Leerstring-Fallback mehr
// nötig (Code-Review Fund 7): der Kontakt existiert an dieser Stelle
// garantiert, da resolveContact() vorher geworfen hätte.
function rowToAssignedContact(db, contactId, assignedAt) {
  const c = db.prepare(`SELECT ${ASSIGNED_CONTACT_COLUMNS} FROM contacts c WHERE c.id=?`).get(contactId);
  return { contactId: c.contactId, name: c.name, role: c.role, email: c.email, assignedAt };
}

// PUT-Mengensemantik: dedupliziert Eingabe, prüft Eigentümerschaft JEDER
// contactId VOR jedem Schreiben (Alles-oder-nichts), entfernt nicht mehr
// genannte, ergänzt neue — alles in einer Transaktion. Bereits vorhandene
// Zuordnungen behalten ihr ursprüngliches assignedAt.
function setAssignments(db, { uid, refType, refId, contactIds, now }) {
  if (!Array.isArray(contactIds) || contactIds.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new ApiError(400, 'INVALID_PAYLOAD', 'Ungültige Auswahl.');
  }
  const uniqueIds = [...new Set(contactIds)];
  if (uniqueIds.length > MAX_ASSIGNMENTS_PER_REF) {
    throw new ApiError(
      400,
      'ASSIGNMENT_LIMIT_REACHED',
      `Es sind maximal ${MAX_ASSIGNMENTS_PER_REF} Ansprechpartner je Vorhaben möglich.`
    );
  }
  // Eigentümerschaft jeder ID prüfen, bevor irgendetwas geschrieben wird.
  for (const cid of uniqueIds) resolveContact(db, uid, cid);

  const existing = db
    .prepare('SELECT contact_id FROM contact_assignments WHERE ref_type=? AND ref_id=? AND user_id=?')
    .all(refType, refId, uid)
    .map((r) => r.contact_id);
  const existingSet = new Set(existing);
  const newSet = new Set(uniqueIds);
  const toRemove = existing.filter((id) => !newSet.has(id));
  const toAdd = uniqueIds.filter((id) => !existingSet.has(id));

  const tx = db.transaction(() => {
    if (toRemove.length) {
      db.prepare(
        `DELETE FROM contact_assignments WHERE ref_type=? AND ref_id=? AND user_id=? AND contact_id IN (${placeholders(
          toRemove.length
        )})`
      ).run(refType, refId, uid, ...toRemove);
    }
    if (toAdd.length) {
      const insert = db.prepare(
        'INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)'
      );
      const createdAt = now();
      for (const cid of toAdd) insert.run(genId(), uid, cid, refType, refId, createdAt);
    }
  });
  tx();

  return listAssignedContacts(db, uid, refType, refId);
}

// POST-Dedupe: bestehende Zuordnung wird ohne Fehler erneut zurückgegeben
// (created:false), keine doppelte Zeile. Prüfung + Insert laufen in einer
// Transaktion (Code-Review Fund 13), analog zu setAssignments.
function addAssignment(db, { uid, refType, refId, contactId, now }) {
  if (!contactId || typeof contactId !== 'string') {
    throw new ApiError(400, 'INVALID_PAYLOAD', 'Ungültige Auswahl.');
  }
  resolveContact(db, uid, contactId);

  let result;
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT contact_id, created_at FROM contact_assignments WHERE ref_type=? AND ref_id=? AND contact_id=? AND user_id=?'
      )
      .get(refType, refId, contactId, uid);
    if (existing) {
      result = { created: false, assignment: rowToAssignedContact(db, contactId, existing.created_at) };
      return;
    }

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM contact_assignments WHERE ref_type=? AND ref_id=? AND user_id=?')
      .get(refType, refId, uid).n;
    if (count >= MAX_ASSIGNMENTS_PER_REF) {
      throw new ApiError(
        400,
        'ASSIGNMENT_LIMIT_REACHED',
        `Es sind maximal ${MAX_ASSIGNMENTS_PER_REF} Ansprechpartner je Vorhaben möglich.`
      );
    }

    const createdAt = now();
    db.prepare(
      'INSERT INTO contact_assignments(id,user_id,contact_id,ref_type,ref_id,created_at) VALUES (?,?,?,?,?,?)'
    ).run(genId(), uid, contactId, refType, refId, createdAt);
    result = { created: true, assignment: rowToAssignedContact(db, contactId, createdAt) };
  });
  tx();

  return result;
}

// Gemeinsame Lösch-Funktion für beide Richtungen (Vorhaben-Seite und
// Kontakt-Seite) — liefert garantiert dasselbe Ergebnis. Idempotent: Löschen
// einer nicht (mehr) existierenden Zuordnung ist kein Fehler. Auf user_id
// skopiert, damit "gehört nicht mir" und "existiert nicht" ununterscheidbar
// bleiben (removed:false in beiden Fällen).
function removeAssignment(db, uid, contactId, refType, refId) {
  const res = db
    .prepare('DELETE FROM contact_assignments WHERE user_id=? AND contact_id=? AND ref_type=? AND ref_id=?')
    .run(uid, contactId, refType, refId);
  return res.changes > 0;
}

// Sammelabfrage für die Anreicherung von Listen (GET /todos, GET /meetings
// durch B4): EINE Query für beliebig viele refs, kein N+1.
// items: [{refType, refId}, ...] -> Map<`${refType}:${refId}`, AssignedContact[]>
function contactsForRefs(db, uid, items) {
  const map = new Map();
  if (!Array.isArray(items) || items.length === 0) return map;

  const todoIds = [];
  const topicIds = [];
  for (const it of items) {
    if (!it || typeof it.refId !== 'string' || !it.refId) continue;
    if (it.refType === 'todo') todoIds.push(it.refId);
    else if (it.refType === 'topic') topicIds.push(it.refId);
  }
  if (todoIds.length === 0 && topicIds.length === 0) return map;

  const clauses = [];
  const params = [];
  if (todoIds.length) {
    clauses.push(`(ca.ref_type='todo' AND ca.ref_id IN (${placeholders(todoIds.length)}))`);
    params.push(...todoIds);
  }
  if (topicIds.length) {
    clauses.push(`(ca.ref_type='topic' AND ca.ref_id IN (${placeholders(topicIds.length)}))`);
    params.push(...topicIds);
  }

  const rows = db
    .prepare(
      `SELECT ca.ref_type AS refType, ca.ref_id AS refId, ca.created_at AS assignedAt, ${ASSIGNED_CONTACT_COLUMNS}
       FROM contact_assignments ca
       JOIN contacts c ON c.id = ca.contact_id AND c.user_id = ?
       WHERE ca.user_id = ? AND (${clauses.join(' OR ')})
       ORDER BY ca.ref_type, ca.ref_id, c.sort_order, c.name`
    )
    .all(uid, uid, ...params);

  for (const r of rows) {
    const key = `${r.refType}:${r.refId}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ contactId: r.contactId, name: r.name, role: r.role, email: r.email, assignedAt: r.assignedAt });
  }
  return map;
}

// Löscht alle Zuordnungen zu den übergebenen Refs (z.B. wenn ein todo/topic
// selbst gelöscht wird — es gibt dafür keine FK-Kaskade, da ref_id
// polymorph ist).
function deleteForRefs(db, refs) {
  if (!Array.isArray(refs) || refs.length === 0) return { deleted: 0 };
  const todoIds = refs
    .filter((r) => r && r.refType === 'todo' && typeof r.refId === 'string' && r.refId)
    .map((r) => r.refId);
  const topicIds = refs
    .filter((r) => r && r.refType === 'topic' && typeof r.refId === 'string' && r.refId)
    .map((r) => r.refId);

  let deleted = 0;
  const tx = db.transaction(() => {
    if (todoIds.length) {
      const res = db
        .prepare(`DELETE FROM contact_assignments WHERE ref_type='todo' AND ref_id IN (${placeholders(todoIds.length)})`)
        .run(...todoIds);
      deleted += res.changes;
    }
    if (topicIds.length) {
      const res = db
        .prepare(`DELETE FROM contact_assignments WHERE ref_type='topic' AND ref_id IN (${placeholders(topicIds.length)})`)
        .run(...topicIds);
      deleted += res.changes;
    }
  });
  tx();
  return { deleted };
}

// Löscht alle Zuordnungen eines Kontakts (zusätzlich zur FK-Kaskade auf
// contacts.id nützlich, falls B1 gezielt aufräumen möchte, ohne den Kontakt
// selbst zu löschen).
function deleteForContact(db, contactId) {
  if (typeof contactId !== 'string' || !contactId) return { deleted: 0 };
  const res = db.prepare('DELETE FROM contact_assignments WHERE contact_id=?').run(contactId);
  return { deleted: res.changes };
}

// Migrations-Hook für die Topic↔ToDo-Konvertierung (Code-Review Hoch-Fund 2):
// contact_assignments nutzt dieselbe polymorphe ref_type/ref_id-Struktur wie
// theme_links, zieht Zuordnungen bei einer Konvertierung aber bislang nicht
// mit. from/to = {refType, refId}. Ein späteres Integrations-Arbeitspaket
// (B4) muss diese Funktion an den Konvertierungs-Stellen in server.js
// verdrahten (siehe Abschlussbericht).
//
// UNIQUE(contact_id, ref_type, ref_id) kann beim UPDATE kollidieren, falls am
// Ziel-Ref bereits eine Zuordnung desselben Kontakts existiert. Zeilen, die
// deshalb per `UPDATE OR IGNORE` nicht aktualisiert wurden, bleiben mit dem
// alten (nach der Konvertierung nicht mehr existierenden) ref_type/ref_id
// zurück und werden anschließend bereinigt.
function moveAssignments(db, from, to) {
  if (!from || !to || !VALID_REF_TYPES.has(from.refType) || !VALID_REF_TYPES.has(to.refType)) {
    throw new Error('moveAssignments: ungültige refType-Angabe');
  }
  if (typeof from.refId !== 'string' || !from.refId || typeof to.refId !== 'string' || !to.refId) {
    throw new Error('moveAssignments: ungültige refId-Angabe');
  }

  let moved = 0;
  const tx = db.transaction(() => {
    const res = db
      .prepare('UPDATE OR IGNORE contact_assignments SET ref_type=?, ref_id=? WHERE ref_type=? AND ref_id=?')
      .run(to.refType, to.refId, from.refType, from.refId);
    moved = res.changes;
    // Verbliebene Kollisions-Zeilen (Kontakt am Ziel bereits zugeordnet)
    // entfernen, statt sie am nicht mehr existierenden Alt-Ref hängen zu
    // lassen.
    db.prepare('DELETE FROM contact_assignments WHERE ref_type=? AND ref_id=?').run(from.refType, from.refId);
  });
  tx();
  return { moved };
}

// Kontakt-Seite: EINE UNION-ALL-Query für die Seite + EINE Count-Query für
// die Kennzahlen (open/done); daraus wird `total` für die Pagination
// abgeleitet (kein separater dritter Count-Query nötig).
function listContactAssignments(db, { uid, contactId, limit, offset, status }) {
  const itemsSql = `
    SELECT * FROM (
      SELECT 'todo' AS refType, t.id AS refId, t.title AS title, t.done AS done,
             NULLIF(t.snoozed_until,'') AS snoozedUntil, NULLIF(t.due_date,'') AS dueDate,
             NULL AS meetingId, NULL AS meetingTitle, ca.created_at AS assignedAt
      FROM contact_assignments ca
      JOIN todos t ON t.id = ca.ref_id AND t.user_id = ca.user_id
      WHERE ca.ref_type='todo' AND ca.contact_id=? AND ca.user_id=?
      UNION ALL
      SELECT 'topic' AS refType, tp.id AS refId, tp.title AS title, tp.done AS done,
             NULLIF(tp.snoozed_until,'') AS snoozedUntil, NULL AS dueDate,
             m.id AS meetingId, m.title AS meetingTitle, ca.created_at AS assignedAt
      FROM contact_assignments ca
      JOIN topics tp ON tp.id = ca.ref_id
      JOIN meetings m ON m.id = tp.meeting_id AND m.user_id = ca.user_id
      WHERE ca.ref_type='topic' AND ca.contact_id=? AND ca.user_id=?
    ) combined
    WHERE (? = 'all') OR (? = 'open' AND done=0) OR (? = 'done' AND done=1)
    ORDER BY done ASC, assignedAt DESC, refId DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db
    .prepare(itemsSql)
    .all(contactId, uid, contactId, uid, status, status, status, limit, offset);

  const countsSql = `
    SELECT
      SUM(CASE WHEN done=0 THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN done=1 THEN 1 ELSE 0 END) AS done
    FROM (
      SELECT t.done AS done FROM contact_assignments ca
        JOIN todos t ON t.id=ca.ref_id AND t.user_id=ca.user_id
        WHERE ca.ref_type='todo' AND ca.contact_id=? AND ca.user_id=?
      UNION ALL
      SELECT tp.done AS done FROM contact_assignments ca
        JOIN topics tp ON tp.id=ca.ref_id
        JOIN meetings m ON m.id=tp.meeting_id AND m.user_id=ca.user_id
        WHERE ca.ref_type='topic' AND ca.contact_id=? AND ca.user_id=?
    ) x
  `;
  const countsRow = db.prepare(countsSql).get(contactId, uid, contactId, uid);
  const counts = { open: countsRow.open || 0, done: countsRow.done || 0 };
  const total = status === 'open' ? counts.open : status === 'done' ? counts.done : counts.open + counts.done;

  const items = rows.map((r) => ({
    refType: r.refType,
    refId: r.refId,
    title: r.title,
    done: !!r.done,
    snoozedUntil: r.snoozedUntil || null,
    dueDate: r.dueDate || null,
    meetingId: r.refType === 'topic' ? r.meetingId : null,
    meetingTitle: r.refType === 'topic' ? r.meetingTitle : null,
    assignedAt: r.assignedAt,
  }));

  return {
    items,
    page: { limit, offset, total, hasMore: offset + items.length < total },
    counts,
  };
}

module.exports = {
  MAX_ASSIGNMENTS_PER_REF,
  VALID_REF_TYPES,
  ApiError,
  placeholders,
  assertValidRefType,
  assertOwnsRef,
  assertWritable,
  resolveContact,
  listAssignedContacts,
  setAssignments,
  addAssignment,
  removeAssignment,
  contactsForRefs,
  deleteForRefs,
  deleteForContact,
  moveAssignments,
  listContactAssignments,
};
