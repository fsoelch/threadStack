'use strict';
// Schreibseite von "Sichtbarer Fortschritt": wird vom Wiring-Paket (M2) aus
// den BESTEHENDEN Routen `PUT /todos/:id` und `PUT /meetings/:mid/topics/:tid`
// aufgerufen, GENAU DANN wenn das jeweilige `done`-Flag sich ändert (der
// Aufrufer prüft das selbst, analog zum bestehenden `descriptionChanged`-
// Muster in server.js).
//
// Verantwortlichkeiten:
// 1) `completed_at` auf dem betroffenen Todo/Thema pflegen (gesetzt beim
//    Abschließen, geleert beim Wiedereröffnen).
// 2) Beim Abschließen (nicht beim Wiedereröffnen) Meilensteine erkennen und
//    in `momentum_milestones` protokollieren, damit die Wochen-Rückblick-
//    Karte sie später (auch nachträglich) auflisten kann.
//
// Greift bewusst per Roh-SQL direkt auf `contact_assignments`/`contacts` zu
// (keine `require('../contacts/...')`-Abhängigkeit) - identisches Muster zu
// anderen lib/-Modulen, die fremde Tabellen lesen, ohne das fremde Modul als
// JS-Abhängigkeit einzubinden (siehe Architektur-Konventionen).
const { genId } = require('./schema');

function nowIsoOf(now) {
  return now instanceof Date ? now.toISOString() : now;
}

function recordMilestone(db, userId, kind, refId, name, occurredAt) {
  db.prepare('INSERT INTO momentum_milestones(id,user_id,kind,ref_id,name,occurred_at) VALUES (?,?,?,?,?,?)')
    .run(genId(), userId, kind, refId, name, occurredAt);
}

// Liefert die Kontakte, für die GENAU JETZT (nach dem Setzen von done=1 auf
// refType/refId) keine offenen zugewiesenen Todos/Themen mehr existieren.
// Läuft NACH dem UPDATE, das den aktuellen Aufruf ausgelöst hat - dadurch ist
// kein Vorher/Nachher-Vergleich nötig: "aktuell nichts mehr offen" bedeutet
// automatisch "dieser Aufruf war der letzte, der es geschlossen hat" (siehe
// domain_momentum.md).
function fullyCompletedContactsFor(db, refType, refId) {
  const assignedContacts = db.prepare(`
    SELECT ca.contact_id AS id, c.name AS name
    FROM contact_assignments ca
    JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.ref_type = ? AND ca.ref_id = ?
  `).all(refType, refId);

  const stillOpen = db.prepare(`
    SELECT 1 FROM contact_assignments ca
    JOIN todos t ON ca.ref_type = 'todo' AND t.id = ca.ref_id
    WHERE ca.contact_id = ? AND t.done = 0
    UNION
    SELECT 1 FROM contact_assignments ca
    JOIN topics tp ON ca.ref_type = 'topic' AND tp.id = ca.ref_id
    WHERE ca.contact_id = ? AND tp.done = 0
    LIMIT 1
  `);

  return assignedContacts.filter((c) => !stillOpen.get(c.id, c.id));
}

// @param {object} args
// @param {string} args.todoId
// @param {string} args.userId
// @param {boolean} args.done - der NEUE Wert (nach der Änderung)
// @param {Date|string} args.now
// @returns {{milestones: Array<{type:'contact', id:string, name:string}>}}
function applyTodoDoneChange(db, { todoId, userId, done, now }) {
  const nowIso = nowIsoOf(now);
  db.prepare('UPDATE todos SET completed_at=? WHERE id=? AND user_id=?')
    .run(done ? nowIso : '', todoId, userId);

  if (!done) return { milestones: [] };

  const contacts = fullyCompletedContactsFor(db, 'todo', todoId);
  const milestones = contacts.map((c) => ({ type: 'contact', id: c.id, name: c.name }));
  for (const m of milestones) recordMilestone(db, userId, 'contact', m.id, m.name, nowIso);
  return { milestones };
}

// @param {object} args
// @param {string} args.topicId
// @param {string} args.userId
// @param {boolean} args.done - der NEUE Wert (nach der Änderung)
// @param {string} args.topicTitle
// @param {Date|string} args.now
// @returns {{milestones: Array<{type:'topic'|'contact', id:string, name:string}>}}
function applyTopicDoneChange(db, { topicId, userId, done, topicTitle, now }) {
  const nowIso = nowIsoOf(now);
  db.prepare('UPDATE topics SET completed_at=? WHERE id=?')
    .run(done ? nowIso : '', topicId);

  if (!done) return { milestones: [] };

  const milestones = [{ type: 'topic', id: topicId, name: topicTitle }];
  recordMilestone(db, userId, 'topic', topicId, topicTitle, nowIso);

  const contacts = fullyCompletedContactsFor(db, 'topic', topicId);
  for (const c of contacts) {
    milestones.push({ type: 'contact', id: c.id, name: c.name });
    recordMilestone(db, userId, 'contact', c.id, c.name, nowIso);
  }
  return { milestones };
}

module.exports = { applyTodoDoneChange, applyTopicDoneChange };
