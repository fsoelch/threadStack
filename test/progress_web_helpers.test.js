'use strict';
// Arbeitspaket W1 (Platzierung/Konsolidierung Fortschrittsverlauf).
//
// Deckt die reinen, DOM-freien Hilfsfunktionen aus public/progress.js ab, die
// über `window.TSProgress` öffentlich sind (Comparator, Badge-Markup,
// Undokumentiert-Prädikat, Datumsformatierung, Entry-Source-Ableitung,
// Leer-HTML-Erkennung) sowie die Dismiss-Logik der Wiedereinstiegskarte.
// DOM-Rendering (mountTimeline/mountReentryCard) wird hier bewusst nicht
// getestet (kein Browser/DOM in dieser Node-Testumgebung) - dafür dient
// public/progress-dev.html als visuelles Prüfwerkzeug.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  compareByProgress,
  isUndocumented,
  badgeHtml,
  formatAbsolute,
  formatRelative,
  durationLabel,
  isReentryDismissed,
  setReentryDismissed,
  clearReentryDismissed,
  dismissStorageKey,
  isValidRefType,
  isValidRefId,
  escHtml,
  deriveEntrySource,
  isEffectivelyEmptyHtml,
  progressLineHtml
} = require(path.join('..', 'public', 'progress.js'));

// ---- Fake localStorage für Dismiss-Tests (kein Browser im Node-Test) ------
function makeFakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

test('compareByProgress: Sortierung nach orderKey', async (t) => {
  await t.test('Item ohne Stand (orderKey=null) landet ans Ende, unabhängig von der Reihenfolge der Argumente', () => {
    const withStand = { progress: { orderKey: '2026-01-01T00:00:00.000Z' } };
    const ohneStand = { progress: { orderKey: null } };
    assert.equal(compareByProgress(ohneStand, withStand), 1);
    assert.equal(compareByProgress(withStand, ohneStand), -1);
  });

  await t.test('beide ohne Stand -> 0 (Aufrufer behält bestehende Sortierung)', () => {
    const a = { progress: { orderKey: null } };
    const b = { progress: null };
    assert.equal(compareByProgress(a, b), 0);
  });

  await t.test('beide ohne progress-Objekt -> 0', () => {
    assert.equal(compareByProgress({}, {}), 0);
  });

  await t.test('älterer Stand (kleineres ISO-Datum) zuerst', () => {
    const older = { progress: { orderKey: '2026-01-01T00:00:00.000Z' } };
    const newer = { progress: { orderKey: '2026-06-01T00:00:00.000Z' } };
    assert.equal(compareByProgress(older, newer), -1);
    assert.equal(compareByProgress(newer, older), 1);
  });

  await t.test('gleicher orderKey -> 0', () => {
    const a = { progress: { orderKey: '2026-01-01T00:00:00.000Z' } };
    const b = { progress: { orderKey: '2026-01-01T00:00:00.000Z' } };
    assert.equal(compareByProgress(a, b), 0);
  });

  await t.test('ist als Array.prototype.sort-Comparator nutzbar (Randfall: 3 Items, eines ohne Stand)', () => {
    const items = [
      { id: 'c', progress: { orderKey: null } },
      { id: 'a', progress: { orderKey: '2026-01-01T00:00:00.000Z' } },
      { id: 'b', progress: { orderKey: '2026-03-01T00:00:00.000Z' } }
    ];
    items.sort(compareByProgress);
    assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'c']);
  });
});

test('isUndocumented: Prädikat für undokumentierte Vorhaben', async (t) => {
  await t.test('true wenn progress.undocumented===true', () => {
    assert.equal(isUndocumented({ progress: { undocumented: true } }), true);
  });
  await t.test('false wenn progress.undocumented===false', () => {
    assert.equal(isUndocumented({ progress: { undocumented: false } }), false);
  });
  await t.test('false wenn progress fehlt', () => {
    assert.equal(isUndocumented({}), false);
  });
  await t.test('false wenn item null/undefined ist', () => {
    assert.equal(isUndocumented(null), false);
    assert.equal(isUndocumented(undefined), false);
  });
  await t.test('false wenn undocumented ein truthy Nicht-Boolean ist (strikter ===true-Check)', () => {
    assert.equal(isUndocumented({ progress: { undocumented: 1 } }), false);
  });
});

test('badgeHtml: Fortschritts-Badge-Markup', async (t) => {
  await t.test("'' wenn progress===null", () => {
    assert.equal(badgeHtml(null), '');
  });
  await t.test("'' wenn entryCount===0 (kein Zwischenstand -> kein Badge)", () => {
    assert.equal(badgeHtml({ entryCount: 0, badgeLabel: null }), '');
  });
  await t.test("'' wenn badgeLabel fehlt, obwohl entryCount>0 (defensiv)", () => {
    assert.equal(badgeHtml({ entryCount: 2, badgeLabel: '' }), '');
  });
  await t.test('normaler Zustand: 📈-Icon, badgeLabel als sichtbarer Text, sprechendes aria-label', () => {
    const html = badgeHtml({
      entryCount: 5, lastEntryAt: '2026-08-20T10:00:00.000Z', badgeLabel: '5 Zwischenstände · vor 3 Tagen',
      badgeEmphasis: 'normal'
    });
    assert.ok(html.includes('📈'));
    assert.ok(html.includes('progress-badge-normal'));
    assert.ok(html.includes('5 Zwischenstände · vor 3 Tagen'));
    assert.match(html, /aria-label="Fortschritt: 5 Zwischenstände, letzter vor \d+ Tagen"/);
    assert.ok(!html.includes('länger nicht aktualisiert'));
  });
  await t.test('stale-Zustand: ⏳-Icon UND Farbklasse wechseln gemeinsam, aria-label ergänzt Hinweis', () => {
    const html = badgeHtml({
      entryCount: 3, lastEntryAt: '2026-07-30T10:00:00.000Z', badgeLabel: '3 Zwischenstände · vor 24 Tagen',
      badgeEmphasis: 'stale'
    });
    assert.ok(html.includes('⏳'));
    assert.ok(!html.includes('📈'));
    assert.ok(html.includes('progress-badge-stale'));
    assert.ok(html.includes('länger nicht aktualisiert'));
  });
  await t.test('Singular "Zwischenstand" bei entryCount===1', () => {
    const html = badgeHtml({ entryCount: 1, lastEntryAt: '2026-08-20T10:00:00.000Z', badgeLabel: '1 Zwischenstand', badgeEmphasis: 'normal' });
    assert.match(html, /aria-label="Fortschritt: 1 Zwischenstand,/);
  });
  await t.test('badgeLabel wird HTML-escaped (kein XSS über serverseitige Daten)', () => {
    const html = badgeHtml({ entryCount: 1, lastEntryAt: '2026-08-20T10:00:00.000Z', badgeLabel: '<img src=x onerror=alert(1)>', badgeEmphasis: 'normal' });
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
  });
});

test('formatAbsolute: deutsches Absolut-Datum', async (t) => {
  await t.test('formatiert ISO-Datum korrekt (Tag. Monat. Jahr)', () => {
    assert.equal(formatAbsolute('2026-08-14T10:00:00.000Z'), '14. Aug. 2026');
  });
  await t.test('leerer String bei ungültigem/fehlendem Datum', () => {
    assert.equal(formatAbsolute('not-a-date'), '');
    assert.equal(formatAbsolute(null), '');
    assert.equal(formatAbsolute(undefined), '');
    assert.equal(formatAbsolute(''), '');
  });
});

test('formatRelative: deutsches Relativ-Datum für verschiedene Zeiträume', async (t) => {
  const now = new Date('2026-08-23T12:00:00.000Z');

  await t.test('heute (0 Tage Differenz)', () => {
    assert.equal(formatRelative('2026-08-23T09:00:00.000Z', now), 'heute');
  });
  await t.test('gestern (1 Tag)', () => {
    assert.equal(formatRelative('2026-08-22T09:00:00.000Z', now), 'gestern');
  });
  await t.test('Tage-Bereich: "vor 9 Tagen" (Dativ, nicht "9 Tage")', () => {
    assert.equal(formatRelative('2026-08-14T12:00:00.000Z', now), 'vor 9 Tagen');
  });
  await t.test('Wochen-Bereich: "vor 3 Wochen"', () => {
    assert.equal(formatRelative('2026-08-02T12:00:00.000Z', now), 'vor 3 Wochen');
  });
  await t.test('leerer String bei ungültigem Datum', () => {
    assert.equal(formatRelative('kaputt', now), '');
    assert.equal(formatRelative(null, now), '');
  });
  await t.test('ohne now-Argument wird die aktuelle Zeit verwendet (kein Absturz)', () => {
    const result = formatRelative(new Date().toISOString());
    assert.equal(typeof result, 'string');
  });
});

test('durationLabel: Nominativ vs. Dativ', async (t) => {
  await t.test('Nominativ (für Ruhephasen-Marker, z.B. "12 Tage Pause")', () => {
    assert.equal(durationLabel(12), '12 Tage');
    assert.equal(durationLabel(1), '1 Tag');
  });
  await t.test('Dativ (für "vor …"-Formulierungen)', () => {
    assert.equal(durationLabel(12, true), '12 Tagen');
    assert.equal(durationLabel(1, true), '1 Tag');
  });
});

test('Wiedereinstiegskarte: Dismiss-Logik (localStorage-Ersatz)', async (t) => {
  await t.test('nicht dismissed, wenn kein dormantSince vorhanden ist', () => {
    const storage = makeFakeStorage();
    assert.equal(isReentryDismissed('todo', 'a1', null, storage), false);
  });

  await t.test('nicht dismissed, wenn noch nichts gespeichert wurde', () => {
    const storage = makeFakeStorage();
    assert.equal(isReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', storage), false);
  });

  await t.test('dismissed, wenn gespeicherter Wert exakt dem aktuellen dormantSince entspricht', () => {
    const storage = makeFakeStorage();
    setReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', storage);
    assert.equal(isReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', storage), true);
  });

  await t.test('Karte erscheint wieder, wenn sich dormantSince ändert (neue Ruhephase)', () => {
    const storage = makeFakeStorage();
    setReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', storage);
    assert.equal(isReentryDismissed('todo', 'a1', '2026-09-15T10:00:00.000Z', storage), false);
  });

  await t.test('Dismiss ist pro Vorhaben (refType:refId) isoliert', () => {
    const storage = makeFakeStorage();
    setReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', storage);
    assert.equal(isReentryDismissed('topic', 'a1', '2026-08-02T10:00:00.000Z', storage), false);
    assert.equal(isReentryDismissed('todo', 'a2', '2026-08-02T10:00:00.000Z', storage), false);
  });

  await t.test('clearReentryDismissed entfernt den gespeicherten Wert wieder', () => {
    const storage = makeFakeStorage();
    setReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', storage);
    clearReentryDismissed('todo', 'a1', storage);
    assert.equal(isReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', storage), false);
  });

  await t.test('setReentryDismissed ohne dormantSince schreibt nichts (defensiv)', () => {
    const storage = makeFakeStorage();
    setReentryDismissed('todo', 'a1', null, storage);
    assert.equal(storage._map.size, 0);
  });

  await t.test('dismissStorageKey folgt dem vorgegebenen Schema ts.progress.dismiss.<refType>:<refId>', () => {
    assert.equal(dismissStorageKey('todo', 'a1'), 'ts.progress.dismiss.todo:a1');
  });

  await t.test('kein Absturz, wenn storage.getItem/.setItem werfen (z.B. Private-Mode-Quota)', () => {
    const throwingStorage = {
      getItem() { throw new Error('quota'); },
      setItem() { throw new Error('quota'); }
    };
    assert.doesNotThrow(() => setReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', throwingStorage));
    assert.equal(isReentryDismissed('todo', 'a1', '2026-08-02T10:00:00.000Z', throwingStorage), false);
  });
});

test('isValidRefType/isValidRefId: Eingabevalidierung für Mount-Aufrufe', async (t) => {
  await t.test('gültige refType-Werte', () => {
    assert.equal(isValidRefType('todo'), true);
    assert.equal(isValidRefType('topic'), true);
  });
  await t.test('ungültige refType-Werte werden abgelehnt', () => {
    assert.equal(isValidRefType('theme'), false);
    assert.equal(isValidRefType(''), false);
    assert.equal(isValidRefType(null), false);
    assert.equal(isValidRefType(undefined), false);
    assert.equal(isValidRefType(123), false);
  });
  await t.test('gültige refId (nicht-leerer String, angemessene Länge)', () => {
    assert.equal(isValidRefId('a1b2c3'), true);
  });
  await t.test('ungültige refId (leer, falscher Typ, zu lang)', () => {
    assert.equal(isValidRefId(''), false);
    assert.equal(isValidRefId(null), false);
    assert.equal(isValidRefId(42), false);
    assert.equal(isValidRefId('x'.repeat(500)), false);
  });
});

test('escHtml: escaped alle relevanten HTML-Sonderzeichen (genutzt für Zielbild/nextStep/Freitext)', async (t) => {
  await t.test('escaped <, >, &, ", \'', () => {
    assert.equal(escHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;');
  });
  await t.test('null/undefined -> leerer String, kein Absturz', () => {
    assert.equal(escHtml(null), '');
    assert.equal(escHtml(undefined), '');
  });
});

test('deriveEntrySource: Herkunft eines Zwischenstands aus snoozedUntil ableiten', async (t) => {
  await t.test("'snooze', wenn snoozedUntil ein nicht-leerer, getrimmter String ist", () => {
    assert.equal(deriveEntrySource({ snoozedUntil: '2026-09-01T00:00:00.000Z' }), 'snooze');
  });
  await t.test("'manual', wenn snoozedUntil nur Whitespace ist ('   ')", () => {
    assert.equal(deriveEntrySource({ snoozedUntil: '   ' }), 'manual');
  });
  await t.test("'manual', wenn snoozedUntil null ist", () => {
    assert.equal(deriveEntrySource({ snoozedUntil: null }), 'manual');
  });
  await t.test("'manual', wenn snoozedUntil undefined ist", () => {
    assert.equal(deriveEntrySource({ snoozedUntil: undefined }), 'manual');
  });
  await t.test("'manual', wenn snoozedUntil ein leerer String ('') ist", () => {
    assert.equal(deriveEntrySource({ snoozedUntil: '' }), 'manual');
  });
  await t.test("'manual', wenn snoozedUntil kein String ist (z.B. Zahl/Objekt/Date)", () => {
    assert.equal(deriveEntrySource({ snoozedUntil: 12345 }), 'manual');
    assert.equal(deriveEntrySource({ snoozedUntil: {} }), 'manual');
    assert.equal(deriveEntrySource({ snoozedUntil: new Date() }), 'manual');
    assert.equal(deriveEntrySource({ snoozedUntil: true }), 'manual');
  });
  await t.test("'manual', wenn das Options-Objekt selbst fehlt/leer ist (defensiv)", () => {
    assert.equal(deriveEntrySource({}), 'manual');
    assert.equal(deriveEntrySource(null), 'manual');
    assert.equal(deriveEntrySource(undefined), 'manual');
  });
  await t.test('führende/nachgestellte Whitespaces um einen echten Wert stören nicht (String bleibt gültig)', () => {
    assert.equal(deriveEntrySource({ snoozedUntil: '  2026-09-01T00:00:00.000Z  ' }), 'snooze');
  });
});

test('isEffectivelyEmptyHtml: erkennt inhaltlich leeres Rich-Text-HTML', async (t) => {
  await t.test("'' ist leer", () => {
    assert.equal(isEffectivelyEmptyHtml(''), true);
  });
  await t.test("'<br>' ist leer", () => {
    assert.equal(isEffectivelyEmptyHtml('<br>'), true);
  });
  await t.test("'<div><br></div>' ist leer", () => {
    assert.equal(isEffectivelyEmptyHtml('<div><br></div>'), true);
  });
  await t.test("'<p>   </p>' (nur Whitespace) ist leer", () => {
    assert.equal(isEffectivelyEmptyHtml('<p>   </p>'), true);
  });
  await t.test("'<p>&nbsp;</p>' (nur nbsp-Entity) ist leer", () => {
    assert.equal(isEffectivelyEmptyHtml('<p>&nbsp;</p>'), true);
  });
  await t.test('reine Whitespace-Strings ohne Tags sind leer', () => {
    assert.equal(isEffectivelyEmptyHtml('   \n\t  '), true);
  });
  await t.test('null/undefined gelten als leer (defensiv)', () => {
    assert.equal(isEffectivelyEmptyHtml(null), true);
    assert.equal(isEffectivelyEmptyHtml(undefined), true);
  });
  await t.test('verschachtelte leere Tags ohne Inhalt sind leer', () => {
    assert.equal(isEffectivelyEmptyHtml('<p><span></span><br></p>'), true);
  });
  await t.test('echter Textinhalt ist NICHT leer', () => {
    assert.equal(isEffectivelyEmptyHtml('<p>Text</p>'), false);
  });
  await t.test('Text neben einem <br> ist NICHT leer', () => {
    assert.equal(isEffectivelyEmptyHtml('<p>Notiz<br>weiter</p>'), false);
  });
  await t.test('reiner Text ohne Tags ist NICHT leer', () => {
    assert.equal(isEffectivelyEmptyHtml('nur Text'), false);
  });
});

test('progressLineHtml: kompakte Fortschrittsanzeige für Übersichtskarten (Story 3)', async (t) => {
  await t.test('kein Zwischenstand -> neutraler Leerzustand, kein Fehler-/Warnzustand', () => {
    const html = progressLineHtml(null);
    assert.match(html, /Noch kein Zwischenstand/);
    assert.match(html, /progress-line-empty/);
  });
  await t.test('entryCount=0 (aber Objekt vorhanden) -> ebenfalls Leerzustand', () => {
    const html = progressLineHtml({ entryCount: 0, badgeLabel: null, badgeEmphasis: 'normal' });
    assert.match(html, /Noch kein Zwischenstand/);
  });
  await t.test('normaler Zustand: Icon + Text, kein "veraltet"', () => {
    const html = progressLineHtml({ entryCount: 3, badgeLabel: '3 Zwischenstände · vor 2 Tagen', badgeEmphasis: 'normal', badgeSuffix: null });
    assert.match(html, /3 Zwischenstände · vor 2 Tagen/);
    assert.doesNotMatch(html, /veraltet/);
    assert.match(html, /progress-line-normal/);
  });
  await t.test('veraltet: Icon UND Text ändern sich, nie nur Farbe', () => {
    const html = progressLineHtml({ entryCount: 5, badgeLabel: '5 Zwischenstände · vor 20 Tagen', badgeEmphasis: 'stale', badgeSuffix: 'länger nicht aktualisiert' });
    assert.match(html, /progress-line-stale/);
    assert.match(html, /⏳/);
    assert.match(html, /länger nicht aktualisiert/);
    assert.match(html, /aria-label="[^"]*länger nicht aktualisiert[^"]*"/);
  });
  await t.test('escaped Label/Suffix gegen XSS', () => {
    const html = progressLineHtml({ entryCount: 1, badgeLabel: '<img src=x onerror=alert(1)>', badgeEmphasis: 'normal', badgeSuffix: '<b>x</b>' });
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<b>/);
  });
});
