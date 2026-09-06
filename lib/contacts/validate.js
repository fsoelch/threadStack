'use strict';
// Gemeinsame Feldvalidierung für Ansprechpartner (Kontakte) - IDENTISCH von
// POST /api/contacts und PUT /api/contacts/:contactId aufgerufen
// (Validierungsparität, siehe Vertrag/NFR-9).

const MAX_CONTACT_NAME = 200;
const MAX_CONTACT_ROLE = 500;
const MAX_CONTACT_EMAIL = 500;
// Einfache, konservative E-Mail-Prüfung (kein RFC-5322-Vollparser - bewusst
// strikt genug, um offensichtlich ungültige Eingaben abzulehnen, ohne
// legitime Adressen zu blockieren).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validiert/normalisiert die Basisfelder eines Kontakts. Wirft NIE - liefert
 * entweder `{ok:true, values:{name,role,email}}` (getrimmt) oder
 * `{ok:false, code, message}` (erster gefundener Fehler, Reihenfolge:
 * name -> role -> email).
 * @param {{name?: *, role?: *, email?: *}} fields
 */
function validateContactFields({ name, role, email } = {}) {
  const cleanName = name == null ? '' : String(name).trim();
  if (!cleanName) {
    return { ok: false, code: 'name_required', message: 'Name ist erforderlich.' };
  }
  if (cleanName.length > MAX_CONTACT_NAME) {
    return { ok: false, code: 'name_too_long', message: 'Der Name darf maximal 200 Zeichen haben.' };
  }

  const cleanRole = role == null ? '' : String(role).trim();
  if (cleanRole.length > MAX_CONTACT_ROLE) {
    return { ok: false, code: 'role_too_long', message: 'Die Rolle darf maximal 500 Zeichen haben.' };
  }

  const cleanEmail = email == null ? '' : String(email).trim();
  if (cleanEmail.length > MAX_CONTACT_EMAIL) {
    return { ok: false, code: 'email_too_long', message: 'Die E-Mail-Adresse darf maximal 500 Zeichen haben.' };
  }
  if (cleanEmail && !EMAIL_RE.test(cleanEmail)) {
    return { ok: false, code: 'email_invalid', message: 'Bitte eine gültige E-Mail-Adresse eingeben.' };
  }

  return { ok: true, values: { name: cleanName, role: cleanRole, email: cleanEmail } };
}

module.exports = {
  validateContactFields,
  MAX_CONTACT_NAME,
  MAX_CONTACT_ROLE,
  MAX_CONTACT_EMAIL,
};
