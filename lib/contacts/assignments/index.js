'use strict';
// Öffentliche Schnittstelle des Moduls (Vertrag zu B4). Namen/Signaturen
// exakt wie in der Architektur-Spezifikation für Arbeitspaket B3 vorgegeben.
//
// moveAssignments zusätzlich exportiert (Nachbesserung Code-Review Hoch-Fund
// 2): B4 muss diese Funktion an den Topic↔ToDo-Konvertierungsstellen in
// server.js verdrahten (siehe Abschlussbericht).

const { runAssignmentMigrations, purgeAssignmentOrphans } = require('./schema');
const { createAssignmentsRouter } = require('./router');
const { contactsForRefs, deleteForRefs, deleteForContact, moveAssignments } = require('./queries');

module.exports = {
  runAssignmentMigrations,
  purgeAssignmentOrphans,
  createAssignmentsRouter,
  contactsForRefs,
  deleteForRefs,
  deleteForContact,
  moveAssignments,
};
