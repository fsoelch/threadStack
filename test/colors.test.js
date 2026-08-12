'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PALETTE,
  contrastRatioOnWhite,
  normalizeColor,
  sanitizeStyleAttribute,
  normalizeInlineColorsInHtml,
  toDocxColor,
} = require('../lib/colors');

test('contrastRatioOnWhite: bekannte Werte', () => {
  assert.equal(contrastRatioOnWhite('#000000'), 21);
  assert.equal(contrastRatioOnWhite('#ffffff'), 1);
  assert.equal(contrastRatioOnWhite('#FFFFFF'), 1); // Grossschreibung
});

test('contrastRatioOnWhite: ungueltige Eingabe -> 1 (kein throw)', () => {
  assert.equal(contrastRatioOnWhite('not-a-color'), 1);
  assert.equal(contrastRatioOnWhite(null), 1);
  assert.equal(contrastRatioOnWhite(undefined), 1);
  assert.equal(contrastRatioOnWhite(123), 1);
});

test('normalizeColor: gueltige Hex-/rgb-Formen (bereits kontrastkonform, keine Abdunkelung noetig)', () => {
  assert.equal(normalizeColor('#000000'), '#000000');
  assert.equal(normalizeColor('#000'), '#000000');
  assert.equal(normalizeColor('#123456'), '#123456');
  assert.equal(normalizeColor('rgb(0,0,0)'), '#000000');
  assert.equal(normalizeColor('rgb(  0 , 0 , 0 )'), '#000000');
});

test('normalizeColor: ungueltige Formen -> null', () => {
  assert.equal(normalizeColor('red'), null); // Farbname
  assert.equal(normalizeColor('hsl(0,100%,50%)'), null);
  assert.equal(normalizeColor('javascript:alert(1)'), null);
  assert.equal(normalizeColor('var(--x)'), null);
  assert.equal(normalizeColor('calc(1px + 2px)'), null);
  assert.equal(normalizeColor('url(x.png)'), null);
  assert.equal(normalizeColor(''), null);
  assert.equal(normalizeColor(null), null);
  assert.equal(normalizeColor(undefined), null);
  assert.equal(normalizeColor(42), null);
  assert.equal(normalizeColor('rgba(0,0,0,0.5)'), null); // Alpha nicht erlaubt
  assert.equal(normalizeColor('rgb(300,0,0)'), null); // > 255
  assert.equal(normalizeColor('#gggggg'), null);
});

test('normalizeColor: dunkelt Farben mit zu geringem Kontrast ab', () => {
  const darkened = normalizeColor('#ffff00'); // helles Gelb, Kontrast << 4.5
  assert.ok(darkened);
  assert.ok(contrastRatioOnWhite(darkened) >= 4.5);
});

test('normalizeColor: neue Palettenfarben orange/gelb/gruen bereits >=4.5:1 und werden NICHT weiter abgedunkelt', () => {
  const expectations = [
    ['#c2410c', PALETTE.orange],
    ['#a16207', PALETTE.gelb],
    ['#15803d', PALETTE.gruen],
  ];
  for (const [input, expected] of expectations) {
    assert.ok(contrastRatioOnWhite(input) >= 4.5, `${input} sollte bereits >=4.5:1 sein`);
    assert.equal(normalizeColor(input), expected.toLowerCase());
  }
});

test('PALETTE: alle Werte erfuellen >=4.5:1 gegen Weiss', () => {
  for (const [name, hex] of Object.entries(PALETTE)) {
    assert.ok(contrastRatioOnWhite(hex) >= 4.5, `${name} (${hex}) unterschreitet 4.5:1`);
  }
});

test('sanitizeStyleAttribute: laesst nur color durch', () => {
  assert.equal(sanitizeStyleAttribute('color:#15803d'), 'color:#15803d');
  assert.equal(sanitizeStyleAttribute('color: #dc2626 ;'), 'color:#dc2626');
});

test('sanitizeStyleAttribute: blockt background-color/expression/url/behavior', () => {
  assert.equal(sanitizeStyleAttribute('background-color:#ff0000'), null);
  assert.equal(sanitizeStyleAttribute('background:#ff0000'), null);
  assert.equal(sanitizeStyleAttribute('color:expression(alert(1))'), null);
  assert.equal(sanitizeStyleAttribute('color:url(javascript:alert(1))'), null);
  assert.equal(sanitizeStyleAttribute('behavior:url(xss.htc)'), null);
  assert.equal(sanitizeStyleAttribute('font-size:20px'), null);
  assert.equal(sanitizeStyleAttribute('position:fixed'), null);
});

test('sanitizeStyleAttribute: color gemischt mit anderen Deklarationen -> nur color bleibt', () => {
  assert.equal(sanitizeStyleAttribute('background-color:#fff;color:#dc2626;font-weight:bold'), 'color:#dc2626');
});

test('sanitizeStyleAttribute: ungueltige/leere Eingaben -> null (kein throw)', () => {
  assert.equal(sanitizeStyleAttribute(''), null);
  assert.equal(sanitizeStyleAttribute(null), null);
  assert.equal(sanitizeStyleAttribute(undefined), null);
  assert.equal(sanitizeStyleAttribute('color:red'), null); // Farbname nicht erlaubt
  assert.equal(sanitizeStyleAttribute(42), null);
});

test('normalizeInlineColorsInHtml: <font color> -> <span style=color>', () => {
  const out = normalizeInlineColorsInHtml('<font color="#dc2626">x</font>');
  assert.equal(out, '<span style="color:#dc2626">x</span>');
});

test('normalizeInlineColorsInHtml: <font> mit ungueltiger Farbe wird entfernt', () => {
  const out = normalizeInlineColorsInHtml('<font color="javascript:alert(1)">x</font>');
  assert.ok(!out.includes('<font'));
  assert.ok(!out.includes('javascript:'));
});

test('normalizeInlineColorsInHtml: style-Attribute werden normalisiert', () => {
  const out = normalizeInlineColorsInHtml('<span style="color:#dc2626;background-color:#000">x</span>');
  assert.equal(out, '<span style="color:#dc2626">x</span>');
});

test('normalizeInlineColorsInHtml: gefaehrliche style-Attribute werden entfernt', () => {
  const out = normalizeInlineColorsInHtml('<div style="behavior:url(xss.htc)">x</div>');
  assert.ok(!out.includes('behavior'));
  assert.ok(!out.includes('style='));
});

test('normalizeInlineColorsInHtml: nicht-String -> leerer String', () => {
  assert.equal(normalizeInlineColorsInHtml(null), '');
  assert.equal(normalizeInlineColorsInHtml(undefined), '');
  assert.equal(normalizeInlineColorsInHtml(123), '');
});

test('toDocxColor: konvertiert korrekt', () => {
  assert.equal(toDocxColor('#15803d'), '15803D');
  assert.equal(toDocxColor('15803d'), '15803D');
  assert.equal(toDocxColor('#1D6FE8'), '1D6FE8');
});

test('toDocxColor: nicht-String -> leerer String (kein throw)', () => {
  assert.equal(toDocxColor(null), '');
  assert.equal(toDocxColor(undefined), '');
  assert.equal(toDocxColor(42), '');
});
