'use strict';
// Arbeitspaket W1 (Web-Client für "Meetings archivieren statt löschen").
//
// Deckt die reinen, DOM-/Netzwerk-freien Formatierungsfunktionen ab, die das
// Archiv-Feature in index.html implementiert (Chip-/Badge-/Impact-/Konflikt-
// Texte). Vorbild: test/progress_web_helpers.test.js — dort wird eine
// eigenständige .js-Datei (public/progress.js) direkt per require() geladen,
// weil sie ein UMD-artiges module.exports besitzt. index.html ist dagegen
// kein eigenständiges CommonJS-Modul (HTML-Dokument mit eingebettetem
// <script>), daher wird hier stattdessen der klar markierte Ausschnitt
// zwischen den Kommentaren "ARCHIVE_PURE_HELPERS_START"/"_END" aus der Datei
// extrahiert und in einer VM-Sandbox ausgeführt (kein Browser/DOM nötig, da
// der Ausschnitt laut Konvention in index.html ausschließlich reine
// Funktionen ohne window/document/fetch-Referenzen enthalten darf).
//
// Für public/graph.js (ebenfalls Teil dieses Arbeitspakets) existiert seit
// diesem Paket ein echtes module.exports (siehe dortige Änderung) — das wird
// unten ganz regulär per require() eingebunden.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadArchiveWebHelpers() {
  const htmlPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const startMarker = '// ---- ARCHIVE_PURE_HELPERS_START';
  const endMarker = '// ---- ARCHIVE_PURE_HELPERS_END';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('ARCHIVE_PURE_HELPERS_START/_END-Marker nicht (mehr) in index.html gefunden — Test kann die Funktionen nicht extrahieren.');
  }
  const snippet = html.slice(startIdx, endIdx);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox, { filename: 'index.html#archive-pure-helpers' });
  return sandbox;
}

const helpers = loadArchiveWebHelpers();
const { archiveTopicChipText, archiveBadgeText, archiveImpactText, archiveStackConflictText } = helpers;
const { isArchivedTopicNode } = require(path.join('..', 'public', 'graph.js'));

test('archiveTopicChipText: "{N} Themen · {N} erledigt"-Chip einer Archiv-Karte', async (t) => {
  await t.test('normaler Fall: 5 Themen, 2 offen -> 3 erledigt', () => {
    assert.equal(archiveTopicChipText(5, 2), '5 Themen · 3 erledigt');
  });
  await t.test('alle offen -> 0 erledigt', () => {
    assert.equal(archiveTopicChipText(4, 4), '4 Themen · 0 erledigt');
  });
  await t.test('keine offenen -> alle erledigt', () => {
    assert.equal(archiveTopicChipText(4, 0), '4 Themen · 4 erledigt');
  });
  await t.test('0 Themen insgesamt', () => {
    assert.equal(archiveTopicChipText(0, 0), '0 Themen · 0 erledigt');
  });
  await t.test('defensiv: fehlende/ungültige Zahlen werden als 0 behandelt', () => {
    assert.equal(archiveTopicChipText(undefined, undefined), '0 Themen · 0 erledigt');
    assert.equal(archiveTopicChipText(null, null), '0 Themen · 0 erledigt');
    assert.equal(archiveTopicChipText(NaN, NaN), '0 Themen · 0 erledigt');
  });
  await t.test('defensiv: openTopicCount > topicCount wird auf topicCount begrenzt (kein negativer erledigt-Wert)', () => {
    assert.equal(archiveTopicChipText(2, 9), '2 Themen · 0 erledigt');
  });
  await t.test('defensiv: negative Eingaben werden auf 0 begrenzt', () => {
    assert.equal(archiveTopicChipText(-3, -1), '0 Themen · 0 erledigt');
  });
});

test('archiveBadgeText: Icon+Text-Badge "🗃 Archiviert am {Datum}" (nie nur Farbe)', async (t) => {
  await t.test('normaler Fall mit fertig formatiertem Datumslabel', () => {
    assert.equal(archiveBadgeText('14. Aug. 2026'), '🗃 Archiviert am 14. Aug. 2026');
  });
  await t.test('enthält immer das Archiv-Icon UND den Text "Archiviert am"', () => {
    const text = archiveBadgeText('01. Jan. 2026');
    assert.ok(text.includes('🗃'));
    assert.ok(text.includes('Archiviert am'));
  });
  await t.test('fehlendes/leeres Datumslabel -> Platzhalter "—" statt Absturz', () => {
    assert.equal(archiveBadgeText(''), '🗃 Archiviert am —');
    assert.equal(archiveBadgeText(null), '🗃 Archiviert am —');
    assert.equal(archiveBadgeText(undefined), '🗃 Archiviert am —');
    assert.equal(archiveBadgeText('   '), '🗃 Archiviert am —');
  });
  await t.test('nicht-String-Eingabe -> Platzhalter statt Absturz', () => {
    assert.equal(archiveBadgeText(12345), '🗃 Archiviert am —');
  });
});

test('archiveImpactText: Zahlen-Text für den "Endgültig löschen"-Dialog', async (t) => {
  await t.test('normaler Fall mit mehreren Einträgen je Kategorie', () => {
    assert.equal(
      archiveImpactText({ topics: 3, progressEntries: 5, attachments: 2 }),
      '3 Themen, 5 Fortschrittseinträge, 2 Anhänge'
    );
  });
  await t.test('Singular je Kategorie bei genau 1', () => {
    assert.equal(
      archiveImpactText({ topics: 1, progressEntries: 1, attachments: 1 }),
      '1 Thema, 1 Fortschrittseintrag, 1 Anhang'
    );
  });
  await t.test('alle Kategorien 0', () => {
    assert.equal(
      archiveImpactText({ topics: 0, progressEntries: 0, attachments: 0 }),
      '0 Themen, 0 Fortschrittseinträge, 0 Anhänge'
    );
  });
  await t.test('fehlendes impact-Objekt -> alle Kategorien defensiv 0 statt Absturz', () => {
    assert.equal(archiveImpactText(null), '0 Themen, 0 Fortschrittseinträge, 0 Anhänge');
    assert.equal(archiveImpactText(undefined), '0 Themen, 0 Fortschrittseinträge, 0 Anhänge');
    assert.equal(archiveImpactText({}), '0 Themen, 0 Fortschrittseinträge, 0 Anhänge');
  });
  await t.test('einzelne fehlende/ungültige Felder werden defensiv als 0 behandelt, andere bleiben unverändert', () => {
    assert.equal(
      archiveImpactText({ topics: 4, progressEntries: undefined, attachments: NaN }),
      '4 Themen, 0 Fortschrittseinträge, 0 Anhänge'
    );
  });
  await t.test('negative Werte werden auf 0 begrenzt', () => {
    assert.equal(
      archiveImpactText({ topics: -2, progressEntries: -1, attachments: -5 }),
      '0 Themen, 0 Fortschrittseinträge, 0 Anhänge'
    );
  });
});

test('archiveStackConflictText: kommagetrennte Themen-Titel für die Stack-Konflikt-Warnung', async (t) => {
  await t.test('mehrere offene Frames -> kommagetrennt in Reihenfolge des Arrays', () => {
    assert.equal(
      archiveStackConflictText([{ topicTitle: 'Budget klären' }, { topicTitle: 'Rollout planen' }]),
      'Budget klären, Rollout planen'
    );
  });
  await t.test('genau ein offenes Frame', () => {
    assert.equal(archiveStackConflictText([{ topicTitle: 'Nur eins' }]), 'Nur eins');
  });
  await t.test('leeres Array -> leerer String', () => {
    assert.equal(archiveStackConflictText([]), '');
  });
  await t.test('fehlendes/ungültiges Array-Argument -> leerer String statt Absturz', () => {
    assert.equal(archiveStackConflictText(null), '');
    assert.equal(archiveStackConflictText(undefined), '');
    assert.equal(archiveStackConflictText('nicht-array'), '');
  });
  await t.test('Einträge ohne (gültigen) topicTitle werden defensiv übersprungen', () => {
    assert.equal(
      archiveStackConflictText([{ topicTitle: 'Gültig' }, {}, { topicTitle: '' }, null, { topicTitle: 42 }]),
      'Gültig'
    );
  });
  await t.test('umgebende Leerzeichen im Titel werden getrimmt', () => {
    assert.equal(archiveStackConflictText([{ topicTitle: '  Mit Leerzeichen  ' }]), 'Mit Leerzeichen');
  });
});

test('isArchivedTopicNode (public/graph.js): Prädikat für den Archiv-Badge im Graph', async (t) => {
  await t.test('true nur für Topic-Knoten mit meta.archived===true', () => {
    assert.equal(isArchivedTopicNode({ type: 'topic', meta: { archived: true } }), true);
  });
  await t.test('false wenn meta.archived===false', () => {
    assert.equal(isArchivedTopicNode({ type: 'topic', meta: { archived: false } }), false);
  });
  await t.test('false für andere Knotentypen, selbst wenn meta.archived===true gesetzt wäre', () => {
    assert.equal(isArchivedTopicNode({ type: 'todo', meta: { archived: true } }), false);
    assert.equal(isArchivedTopicNode({ type: 'theme', meta: { archived: true } }), false);
    assert.equal(isArchivedTopicNode({ type: 'knowledge', meta: { archived: true } }), false);
    assert.equal(isArchivedTopicNode({ type: 'contact', meta: { archived: true } }), false);
  });
  await t.test('false wenn meta fehlt oder Knoten null/undefined ist (defensiv)', () => {
    assert.equal(isArchivedTopicNode({ type: 'topic' }), false);
    assert.equal(isArchivedTopicNode(null), false);
    assert.equal(isArchivedTopicNode(undefined), false);
  });
  await t.test('false wenn archived ein truthy Nicht-Boolean ist (strikter ===true-Check)', () => {
    assert.equal(isArchivedTopicNode({ type: 'topic', meta: { archived: 1 } }), false);
  });
});
