'use strict';
// Smoke-Test für die B4-Vertragsfläche von lib/contacts (Code-Review-Fund
// "Mittel #7"): kein anderes Testfile lädt `require('../lib/contacts')`
// direkt - dieser Test stellt sicher, dass die öffentliche API des Moduls
// (die B4 beim Wiring in server.js benötigt) tatsächlich in der erwarteten
// Form exportiert wird.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const contacts = require('../lib/contacts');

const EXPECTED_EXPORTS = [
  'createContactsRouter',
  'runContactMigrations',
  'ensureContactNoteTriggers',
  'purgeContactOrphans',
  'migrateContactDescriptions',
  'ensureDefaultCategories',
];

test('lib/contacts/index.js exportiert alle sechs Vertragsfunktionen als function', () => {
  for (const name of EXPECTED_EXPORTS) {
    assert.equal(typeof contacts[name], 'function', `Export "${name}" fehlt oder ist keine Funktion`);
  }
});

test('lib/contacts/index.js exportiert keine unerwarteten zusätzlichen Schlüssel', () => {
  assert.deepEqual(Object.keys(contacts).sort(), [...EXPECTED_EXPORTS].sort());
});
