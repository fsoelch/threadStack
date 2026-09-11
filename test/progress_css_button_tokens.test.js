'use strict';

// Regressionstest fuer einen Kontrast-Bug im Zwischenstand-Composer: der
// "Speichern"-Knopf (.progress-btn-primary) wurde bei :hover unlesbar
// (weisser Text auf weiss/transparent), weil das eigenstaendige Custom-
// Property-Scope von ".progress-inline-composer" (Uebersichtskarte /
// Composer, siehe progress.js#ComposerInstance) die Variable
// "--p-primary-dark" nicht definierte, die ".progress-btn-primary:hover"
// OHNE Fallback konsumiert (var(--p-primary-dark) ohne zweites Argument).
// Eine fehlende Custom Property macht so ein `background`-Shorthand
// ungueltig -> Browser setzt es auf "initial" (transparent) zurueck,
// waehrend `color:#fff` (Basiszustand) unveraendert bleibt.
//
// Dieser Test prueft NICHT das tatsaechliche Rendering (jsdom berechnet
// CSS-Custom-Properties nicht zuverlaessig), sondern stellt sicher, dass
// jedes Custom Property, das von .progress-btn-primary/.progress-btn-
// secondary (inkl. deren :hover-Zustaenden) OHNE Fallback konsumiert wird,
// in JEDEM Scope definiert ist, der diese Buttons tatsaechlich verwendet
// (".progress-timeline"/".progress-reentry-wrap" UND ".progress-inline-
// composer"/".progress-summary-box"/".progress-line") - so kann derselbe
// Fehler nicht unbemerkt wieder auftreten, auch bei zukuenftigen neuen
// Tokens.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'public', 'progress.css');

function readCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

// Extrahiert die Custom-Property-Namen, die im Rumpf eines Selektor-Blocks
// (":root"-artiges Scope, z.B. ".progress-timeline, .progress-reentry-wrap
// { --p-x: ...; }") DEFINIERT werden.
function definedTokensForSelector(css, selector) {
  const idx = css.indexOf(selector);
  assert.notEqual(idx, -1, `Selektor "${selector}" nicht in progress.css gefunden`);
  const braceStart = css.indexOf('{', idx);
  const braceEnd = css.indexOf('}', braceStart);
  const body = css.slice(braceStart + 1, braceEnd);
  return new Set([...body.matchAll(/--p-[a-z0-9-]+(?=\s*:)/g)].map((m) => m[0]));
}

// Findet alle var(--p-x) OHNE zweites Fallback-Argument innerhalb der
// Regeln fuer die uebergebenen Klassennamen (z.B. .progress-btn-primary,
// .progress-btn-primary:hover:not(:disabled), ...).
function requiredTokensForButtonClass(css, className) {
  const required = new Set();
  const ruleRe = new RegExp(
    '\\.' + className.replace('.', '\\.') + '[^{]*\\{([^}]*)\\}',
    'g'
  );
  let m;
  while ((m = ruleRe.exec(css))) {
    const body = m[1];
    for (const varMatch of body.matchAll(/var\((--p-[a-z0-9-]+)\)/g)) {
      required.add(varMatch[1]);
    }
    // var(--p-x, fallback) hat ein Komma -> zaehlt NICHT, weil er robust
    // gegen ein fehlendes Token ist. matchAll oben erfasst wegen `\)`
    // direkt nach dem Namen ohnehin nur die fallback-losen Aufrufe.
  }
  return required;
}

test('progress.css: .progress-inline-composer definiert dieselben Button-Tokens wie .progress-timeline', () => {
  const css = readCss();
  const composerScopeSelector = '.progress-line, .progress-inline-composer, .progress-summary-box';
  const timelineScopeSelector = '.progress-timeline,\n.progress-reentry-wrap';

  const composerTokens = definedTokensForSelector(css, composerScopeSelector);
  const timelineTokens = definedTokensForSelector(css, timelineScopeSelector);

  const requiredByPrimary = requiredTokensForButtonClass(css, 'progress-btn-primary');
  const requiredBySecondary = requiredTokensForButtonClass(css, 'progress-btn-secondary');
  const requiredByIconBtn = requiredTokensForButtonClass(css, 'progress-icon-btn');

  // Testannahme: die Erkennungslogik selbst funktioniert (findet ueberhaupt
  // fallback-lose var()-Aufrufe) - .progress-icon-btn:hover nutzt bewusst
  // KEINEN Fallback fuer --p-text, da beide Scopes es garantiert definieren.
  assert.ok(requiredByIconBtn.has('--p-text'), 'Testannahme verletzt: .progress-icon-btn:hover sollte --p-text ohne Fallback referenzieren');

  for (const token of [...requiredByPrimary, ...requiredBySecondary, ...requiredByIconBtn]) {
    assert.ok(
      timelineTokens.has(token),
      `Testannahme verletzt: .progress-timeline sollte ${token} definieren`
    );
    assert.ok(
      composerTokens.has(token),
      `Regression: .progress-inline-composer/.progress-summary-box/.progress-line definiert ${token} nicht, ` +
      `obwohl ein dort verwendeter Button (.progress-btn-primary/-secondary/-icon-btn) diese Variable ohne ` +
      `Fallback konsumiert. Das macht die betroffene CSS-Deklaration ungueltig -> unlesbarer Button ` +
      `(z.B. weisser Text auf transparentem/weissem Grund bei :hover).`
    );
  }
});

test('progress.css: .progress-btn-primary:hover bleibt bei einem transparent-Fallback nicht unlesbar (Kontrast-Grundannahme)', () => {
  const css = readCss();
  const baseMatch = /\.progress-btn-primary\s*\{([^}]*)\}/.exec(css);
  assert.ok(baseMatch, '.progress-btn-primary Basisregel nicht gefunden');
  assert.match(baseMatch[1], /color:\s*#fff/, 'Basiszustand sollte weissen Text setzen (Kontrast zum blauen Hintergrund)');

  const hoverMatch = /\.progress-btn-primary:hover:not\(:disabled\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(hoverMatch, '.progress-btn-primary:hover:not(:disabled) Regel nicht gefunden');
  // Hover darf den Hintergrund NICHT auf eine Variable ohne Fallback setzen,
  // die in irgendeinem Nutzungs-Scope fehlen koennte.
  assert.doesNotMatch(
    hoverMatch[1],
    /background:\s*var\(--p-primary-dark\)\s*;/,
    'Hover-Hintergrund sollte einen Fallback-Wert haben (var(--p-primary-dark, #1560CC)) oder das Token muss ' +
    'garantiert in jedem Scope definiert sein (siehe Test oben) - sonst droht ein weisser, unlesbarer Button.'
  );
});
