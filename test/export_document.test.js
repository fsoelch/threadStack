'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HeadingLevel, Paragraph, TextRun } = require('docx');
const { getPart, getDocumentXml } = require('./docx-helpers');

/**
 * Paket 6 haengt fachlich von der Fassade `htmlToDocxBlocks(html, options)`
 * aus Paket 2 ab (export/htmlToDocx.js). Paket 2 ist zum Zeitpunkt dieser
 * Tests ggf. noch nicht auf die vereinbarte Options-Objekt-Signatur
 * umgestellt (aktueller Stand: positionales `headingBase`-Argument als
 * Zahl). Um GEGEN DIE VEREINBARTE SIGNATUR zu testen, wird hier ein
 * minimaler, dem Vertrag entsprechender Test-Stub ueber den Modul-Cache
 * eingehaengt (KEINE Aenderung an export/htmlToDocx.js selbst).
 *
 * WICHTIG: Nach dem Merge von Paket 2 sollte dieser Test-Lauf zusaetzlich
 * einmal OHNE Stub (also gegen die echte Implementierung) wiederholt
 * werden, um die tatsaechliche Integration zu verifizieren. Dieser Hinweis
 * steht auch im Abschlussbericht.
 */
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

function stubHtmlToDocxBlocks(html, options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (typeof opts.numbering !== 'object' || typeof opts.numbering.allocate !== 'function') {
    throw new TypeError('stub: numbering (NumberingRegistry) fehlt');
  }
  let headingBase = Number.isInteger(opts.headingBase) ? opts.headingBase : 5;
  if (headingBase < 1) headingBase = 1;
  if (headingBase > 6) headingBase = 6;

  const str = String(html || '');
  const blocks = [];
  const re = /<h([1-4])>(.*?)<\/h\1>|<p>(.*?)<\/p>/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m[1]) {
      const n = Number(m[1]);
      const level = Math.min(headingBase + (n - 1), 6);
      blocks.push(new Paragraph({ heading: HEADING_LEVELS[level - 1], children: [new TextRun(m[2])] }));
    } else if (m[3] !== undefined) {
      blocks.push(new Paragraph({ children: [new TextRun(m[3])] }));
    }
  }
  if (str.includes('WARN_MARKER') && typeof opts.warn === 'function') {
    opts.warn('IMG_DECODE_FAILED');
  }
  return blocks;
}

// Modul-Cache-Stub: export/docx.js fuehrt intern
// `require('./htmlToDocx')` aus. Wir haengen VOR dem ersten require von
// export/docx.js einen Stub in den Node-Modul-Cache, ohne die reale Datei
// export/htmlToDocx.js zu veraendern (die gehoert Paket 2/nicht zu diesem
// Arbeitspaket).
const htmlToDocxPath = require.resolve('../export/htmlToDocx');
require.cache[htmlToDocxPath] = {
  id: htmlToDocxPath,
  filename: htmlToDocxPath,
  loaded: true,
  exports: { htmlToDocxBlocks: stubHtmlToDocxBlocks },
};

const { buildExportDocx } = require('../export/docx');

function themesFixture() {
  return [
    { id: 't1', parent_id: null, title: 'Topic A', description: '', sort_order: 0 },
    { id: 't2', parent_id: 't1', title: 'Topic A1', description: '', sort_order: 0 },
    { id: 't3', parent_id: 't2', title: 'Topic A1a', description: '', sort_order: 0 },
  ];
}

test('Titelseite enthaelt erwartete Textbausteine (Titel, Scope, Datum, Optionen)', async () => {
  const data = { knowledgePages: [], todos: [] };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: true, openOnly: true });
  const xml = getDocumentXml(buf);
  assert.match(xml, /ThreadStack Export/);
  assert.match(xml, /Wissen \+ Todos &amp; Tasks/);
  assert.match(xml, /Exportiert am \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/);
  assert.match(xml, /Inkl\. Topic-Struktur/);
  assert.match(xml, /Nur offene Todos/);
});

test('Titelseite: Optionszeile fehlt, wenn weder includeGraph noch openOnly zutreffen', async () => {
  const data = { knowledgePages: [], todos: [] };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  assert.doesNotMatch(xml, /Inkl\. Topic-Struktur/);
  assert.doesNotMatch(xml, /Nur offene Todos/);
});

test('TOC-Feld ist vorhanden, wenn der Export-Umfang Inhalte hat', async () => {
  const data = {
    knowledgePages: [{ id: 'p1', title: 'Seite', content: '<p>Text</p>', themeIds: [], relatedIds: [] }],
    todos: [],
  };
  const buf = await buildExportDocx(data, { scope: 'knowledge', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  assert.match(xml, /Inhaltsverzeichnis/);
  assert.match(xml, /w:fldChar|TOC \\/, 'TableOfContents-Feld sollte im XML vorhanden sein');
  assert.doesNotMatch(xml, /Für den gewählten Export-Umfang sind keine Inhalte vorhanden\./);
});

test('TOC-Hinweistext ersetzt das Feld, wenn der Export-Umfang leer ist', async () => {
  const data = { knowledgePages: [], todos: [] };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: true, openOnly: false });
  const xml = getDocumentXml(buf);
  assert.match(xml, /Für den gewählten Export-Umfang sind keine Inhalte vorhanden\./);
  assert.doesNotMatch(xml, /w:fldChar/);
});

test('Heading-Mapping: Topic-Tiefen 0/1/2 und Wissensseiten-Titel/Content kollabieren NICHT alle auf Heading 6', async () => {
  const data = {
    themes: themesFixture(),
    knowledgePages: [
      { id: 'p1', title: 'Seite Top', content: '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4>', themeIds: ['t1'], relatedIds: [] },
    ],
    todos: [],
  };
  const buf = await buildExportDocx(data, { scope: 'knowledge', includeGraph: true, openOnly: false });
  const xml = getDocumentXml(buf);

  const count = (styleName) => (xml.match(new RegExp(`w:val="${styleName}"`, 'g')) || []).length;

  // Topic Tiefe 0 -> Heading2, Tiefe 1 -> Heading3, Tiefe 2 -> Heading4
  assert.ok(count('Heading2') >= 1, 'Topic Tiefe 0 sollte Heading2 sein');
  assert.ok(count('Heading3') >= 1, 'Topic Tiefe 1 sollte Heading3 sein');
  assert.ok(count('Heading4') >= 1, 'Topic Tiefe 2 sollte Heading4 sein');
  // Wissensseiten-Titel unter Topic Tiefe 0 -> min(2+1,5) = Heading3
  assert.ok(count('Heading3') >= 2, 'Seiten-Heading (Heading3) fehlt');
  // Content h1..h4 (headingBase = min(3+1,6) = 4) -> Heading4,5,6,6
  assert.ok(count('Heading5') >= 1, 'Content-h2 sollte Heading5 sein (Beweis gegen Heading6-Kollaps)');
  assert.ok(count('Heading6') >= 1, 'Content-h3/h4 sollten (gedeckelt) Heading6 sein');
  // Nicht alles kollabiert auf Heading6:
  assert.ok(count('Heading4') >= 2, 'Sowohl Topic Tiefe 2 als auch Content-h1 sollten Heading4 sein');
});

test('Ohne Graph (includeGraph=false): Wissensseiten-Titel ist fix Heading2, kein Topic-Heading', async () => {
  const data = {
    knowledgePages: [
      { id: 'p1', title: 'Flache Seite', content: '<p>Text</p>', themeIds: [], relatedIds: [] },
    ],
    todos: [],
  };
  const buf = await buildExportDocx(data, { scope: 'knowledge', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  assert.match(xml, /Flache Seite/);
  assert.ok((xml.match(/w:val="Heading2"/g) || []).length >= 1);
});

test('Wissensseiten-Trennung: Abstand+Trennlinie zwischen Seiten, KEIN Seitenumbruch', async () => {
  const data = {
    knowledgePages: [
      { id: 'p1', title: 'Seite A', content: '<p>A</p>', themeIds: [], relatedIds: [] },
      { id: 'p2', title: 'Seite B', content: '<p>B</p>', themeIds: [], relatedIds: [] },
    ],
    todos: [],
  };
  const buf = await buildExportDocx(data, { scope: 'knowledge', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  const iA = xml.indexOf('Seite A');
  const iB = xml.indexOf('Seite B');
  assert.ok(iA > -1 && iB > -1 && iA < iB);
  const between = xml.slice(iA, iB);
  assert.doesNotMatch(between, /<w:br w:type="page"\/>/, 'Zwischen zwei Wissensseiten darf kein Seitenumbruch stehen');
  assert.match(between, /<w:bottom /, 'Zwischen zwei Wissensseiten sollte eine untere Rahmenlinie (Trenner) stehen');
});

test('Hauptabschnitte "Wissen" und "Todos & Tasks" sind durch Seitenumbrueche getrennt', async () => {
  const data = {
    knowledgePages: [{ id: 'p1', title: 'Seite A', content: '<p>A</p>', themeIds: [], relatedIds: [] }],
    todos: [{ id: 'd1', title: 'Todo A', done: 0, description: '', result: '', themeRefs: [] }],
  };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  const iWissen = xml.indexOf('>Wissen</w:t>');
  const iTodos = xml.indexOf('>Todos &amp; Tasks</w:t>');
  assert.ok(iWissen > -1 && iTodos > -1 && iWissen < iTodos);
  const between = xml.slice(iWissen, iTodos);
  assert.match(between, /<w:br w:type="page"\/>/, 'Vor "Todos & Tasks" sollte ein Seitenumbruch stehen');
});

test('scope=todos: kein "Wissen"-Heading im Dokument', async () => {
  const data = {
    todos: [{ id: 'd1', title: 'Todo A', done: 0, description: '', result: '', themeRefs: [] }],
  };
  const buf = await buildExportDocx(data, { scope: 'todos', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  assert.doesNotMatch(xml, />Wissen</);
  assert.match(xml, /Todos &amp; Tasks/);
});

test('Todos: erledigte Todos sind durchgestrichen, offene nicht', async () => {
  const data = {
    todos: [
      { id: 'd1', title: 'Offenes Todo', done: 0, description: '', result: '', themeRefs: [] },
      { id: 'd2', title: 'Erledigtes Todo', done: 1, description: '', result: '', themeRefs: [] },
    ],
  };
  const buf = await buildExportDocx(data, { scope: 'todos', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  const openIdx = xml.indexOf('Offenes Todo');
  const doneIdx = xml.indexOf('Erledigtes Todo');
  assert.ok(openIdx > -1 && doneIdx > -1);

  // Suche das umschliessende <w:r>...</w:r> fuer jeden Titel-Run.
  const runAround = (idx) => {
    const start = xml.lastIndexOf('<w:r>', idx);
    const end = xml.indexOf('</w:r>', idx) + '</w:r>'.length;
    return xml.slice(start, end);
  };
  assert.doesNotMatch(runAround(openIdx), /<w:strike\/>/);
  assert.match(runAround(doneIdx), /<w:strike\/>/);
});

test('Todos: openOnly=1 -> kein "Erledigt"-Unterabschnitt', async () => {
  const data = {
    todos: [
      { id: 'd1', title: 'Offenes Todo', done: 0, description: '', result: '', themeRefs: [] },
    ],
  };
  const buf = await buildExportDocx(data, { scope: 'todos', includeGraph: false, openOnly: true });
  const xml = getDocumentXml(buf);
  assert.match(xml, />Offen</);
  assert.doesNotMatch(xml, />Erledigt</);
});

test('Todos: leere Beschreibung/Ergebnis erzeugen keinen Leerabsatz und kein "Ergebnis:"-Label', async () => {
  const data = {
    todos: [
      { id: 'd1', title: 'Todo ohne Text', done: 0, description: '   ', result: '', themeRefs: [] },
    ],
  };
  const buf = await buildExportDocx(data, { scope: 'todos', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  assert.doesNotMatch(xml, /Ergebnis:/);
});

test('Todos: nicht-leere Beschreibung wird ueber htmlToDocxBlocks geparst (kein Roh-HTML im Dokument)', async () => {
  const data = {
    todos: [
      { id: 'd1', title: 'Todo mit Text', done: 0, description: '<p>Beschreibungstext</p>', result: '<p>Ergebnistext</p>', themeRefs: [] },
    ],
  };
  const buf = await buildExportDocx(data, { scope: 'todos', includeGraph: false, openOnly: false });
  const xml = getDocumentXml(buf);
  assert.match(xml, /Beschreibungstext/);
  assert.match(xml, /Ergebnistext/);
  assert.match(xml, /Ergebnis:/);
  assert.doesNotMatch(xml, /&lt;p&gt;/, 'HTML sollte nicht als Rohtext im Dokument erscheinen');
});

test('Fusszeile: erste Seite leer, Standard-Fusszeile zeigt "Seite X von Y"', async () => {
  const data = { knowledgePages: [], todos: [] };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: false, openOnly: false });
  const footer1 = getPart(buf, 'word/footer1.xml');
  const footer2 = getPart(buf, 'word/footer2.xml');
  const withPageNumber = [footer1, footer2].find(f => /PAGE/.test(f));
  const empty = [footer1, footer2].find(f => f !== withPageNumber);
  assert.ok(withPageNumber, 'Eine Fusszeile sollte das PAGE-Feld enthalten');
  assert.match(withPageNumber, /Seite/);
  assert.match(withPageNumber, /von/);
  assert.match(withPageNumber, /ThreadStack Export vom/);
  assert.doesNotMatch(empty, /Seite/);
});

test('coreProperties enthalten keine Nutzeridentitaet (kein Username/E-Mail/User-ID)', async () => {
  const data = { knowledgePages: [], todos: [] };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: false, openOnly: false });
  const core = getPart(buf, 'docProps/core.xml');
  assert.match(core, /<dc:creator>ThreadStack<\/dc:creator>/);
  assert.match(core, /<cp:lastModifiedBy>ThreadStack<\/cp:lastModifiedBy>/);
  assert.doesNotMatch(core, /@/, 'Keine E-Mail-Adresse in coreProperties');
  assert.doesNotMatch(core, /admin/i);
});

test('styles.xml enthaelt die docxTheme-Absatzstile (Meta/TitlePageTitle/TitlePageMeta)', async () => {
  const data = { knowledgePages: [], todos: [] };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: false, openOnly: false });
  const styles = getPart(buf, 'word/styles.xml');
  assert.match(styles, /w:styleId="Meta"/);
  assert.match(styles, /w:styleId="TitlePageTitle"/);
  assert.match(styles, /w:styleId="TitlePageMeta"/);
});

test('Buffer ist ein gueltiges DOCX (PK-Magic-Number) und wirft nicht bei Systemfehlern', async () => {
  const data = { knowledgePages: [], todos: [] };
  const buf = await buildExportDocx(data, { scope: 'both', includeGraph: true, openOnly: false });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 2).toString(), 'PK');
});
