'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractReadableText, ExtractError } = require('../lib/html-extract');

// Erzeugt einen langen Absatztext, damit die 200-Zeichen-Mindestlänge
// zuverlässig erreicht wird.
function longParagraph(n = 300) {
  return Array.from({ length: n }, (_, i) => `Wort${i}`).join(' ');
}

test('extractReadableText: no_text_content', async (t) => {
  await t.test('Seite mit nur Script-Inhalt wirft no_text_content', () => {
    const html = `<html><head><script>${longParagraph()}</script></head><body></body></html>`;
    assert.throws(() => extractReadableText(Buffer.from(html, 'utf-8')), (err) => {
      assert.ok(err instanceof ExtractError);
      assert.equal(err.code, 'no_text_content');
      return true;
    });
  });

  await t.test('leeres HTML wirft no_text_content', () => {
    assert.throws(() => extractReadableText(Buffer.from('<html><body></body></html>')), (err) => {
      assert.equal(err.code, 'no_text_content');
      return true;
    });
  });

  await t.test('sehr kurzer Text (< 200 Zeichen) wirft no_text_content', () => {
    const html = `<html><body><p>Kurzer Text.</p></body></html>`;
    assert.throws(() => extractReadableText(Buffer.from(html)), (err) => {
      assert.equal(err.code, 'no_text_content');
      return true;
    });
  });
});

test('extractReadableText: Titel-Extraktion', async (t) => {
  await t.test('nutzt <title>, wenn vorhanden', () => {
    const html = `<html><head><title>Mein Titel</title></head><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.title, 'Mein Titel');
  });

  await t.test('fällt auf og:title zurück, wenn <title> fehlt', () => {
    const html = `<html><head><meta property="og:title" content="OG Titel"></head><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.title, 'OG Titel');
  });

  await t.test('leerer String, wenn weder title noch og:title vorhanden', () => {
    const html = `<html><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.title, '');
  });

  await t.test('Titel wird auf 300 Zeichen gekürzt', () => {
    const longTitle = 'T'.repeat(400);
    const html = `<html><head><title>${longTitle}</title></head><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.title.length, 300);
  });
});

test('extractReadableText: lang-Extraktion', async (t) => {
  await t.test('lang="de" wird erkannt', () => {
    const html = `<html lang="de"><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.lang, 'de');
  });

  await t.test('lang="en" wird erkannt', () => {
    const html = `<html lang="en-US"><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.lang, 'en');
  });

  await t.test('fehlendes lang-Attribut liefert leeren String', () => {
    const html = `<html><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.lang, '');
  });

  await t.test('unbekannte Sprache liefert leeren String', () => {
    const html = `<html lang="fr"><body><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.equal(result.lang, '');
  });
});

test('extractReadableText: Charset-Fallback-Verhalten', async (t) => {
  await t.test('expliziter charset-Parameter wird verwendet', () => {
    const text = `Ünïcödé ${longParagraph()}`;
    const body = Buffer.from(`<html><body><p>${text}</p></body></html>`, 'utf-8');
    const result = extractReadableText(body, { charset: 'utf-8' });
    assert.ok(result.text.includes('Ünïcödé'));
  });

  await t.test('kein charset-Parameter, aber <meta charset> vorhanden -> wird berücksichtigt', () => {
    const text = `Grüße ${longParagraph()}`;
    const html = `<html><head><meta charset="utf-8"></head><body><p>${text}</p></body></html>`;
    const body = Buffer.from(html, 'utf-8');
    const result = extractReadableText(body);
    assert.ok(result.text.includes('Grüße'));
  });

  await t.test('kein charset-Parameter und kein <meta charset> -> UTF-8-Fallback', () => {
    const text = `Standard ${longParagraph()}`;
    const html = `<html><body><p>${text}</p></body></html>`;
    const body = Buffer.from(html, 'utf-8');
    const result = extractReadableText(body);
    assert.ok(result.text.includes('Standard'));
  });

  await t.test('unbekanntes/nicht unterstütztes charset-Label fällt auf UTF-8 zurück', () => {
    const text = `Fallback ${longParagraph()}`;
    const html = `<html><body><p>${text}</p></body></html>`;
    const body = Buffer.from(html, 'utf-8');
    const result = extractReadableText(body, { charset: 'not-a-real-charset' });
    assert.ok(result.text.includes('Fallback'));
  });
});

test('extractReadableText: maxChars-Kürzung', async (t) => {
  await t.test('setzt truncated: true und kürzt den Text', () => {
    const html = `<html><body><p>${longParagraph(1000)}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html), { maxChars: 500 });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 500);
  });

  await t.test('kein truncated, wenn Text unter maxChars bleibt', () => {
    const html = `<html><body><p>${longParagraph(50)}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html), { maxChars: 12000 });
    assert.equal(result.truncated, false);
  });
});

test('extractReadableText: Script/Style/Nav/Footer werden ausgeschlossen', async (t) => {
  await t.test('script-Inhalt landet nicht im Text', () => {
    const html = `<html><body><script>geheimerSkriptText(${longParagraph()})</script><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.ok(!result.text.includes('geheimerSkriptText'));
  });

  await t.test('style-Inhalt landet nicht im Text', () => {
    const html = `<html><body><style>.x{content:"geheimerStilText"}</style><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.ok(!result.text.includes('geheimerStilText'));
  });

  await t.test('nav-Inhalt landet nicht im Text', () => {
    const html = `<html><body><nav>NavigationsLinkText</nav><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.ok(!result.text.includes('NavigationsLinkText'));
  });

  await t.test('footer-Inhalt landet nicht im Text', () => {
    const html = `<html><body><p>${longParagraph()}</p><footer>FooterCopyrightText</footer></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.ok(!result.text.includes('FooterCopyrightText'));
  });

  await t.test('weitere verworfene Tags (noscript, template, svg, iframe, header, aside, form, button, select)', () => {
    const html = `<html><body>
      <header>HeaderText</header>
      <aside>AsideText</aside>
      <form><button>ButtonText</button><select><option>OptionText</option></select></form>
      <iframe src="x">IframeText</iframe>
      <svg><text>SvgText</text></svg>
      <noscript>NoscriptText</noscript>
      <template>TemplateText</template>
      <p>${longParagraph()}</p>
    </body></html>`;
    const result = extractReadableText(Buffer.from(html));
    for (const forbidden of ['HeaderText', 'AsideText', 'ButtonText', 'OptionText', 'IframeText', 'SvgText', 'NoscriptText', 'TemplateText']) {
      assert.ok(!result.text.includes(forbidden), `${forbidden} sollte nicht im Text enthalten sein`);
    }
  });
});

test('extractReadableText: Blocktrennung und Whitespace-Normalisierung', async (t) => {
  await t.test('Blockelemente erzeugen Zeilenumbrüche', () => {
    const html = `<html><body><p>Erster Absatz mit ${longParagraph(60)}</p><p>Zweiter Absatz mit ${longParagraph(60)}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.ok(result.text.includes('\n'));
  });

  await t.test('mehr als 2 aufeinanderfolgende Zeilenumbrüche werden auf 2 reduziert', () => {
    const html = `<html><body><p>${longParagraph()}</p><div></div><div></div><div></div><div></div><p>${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.ok(!result.text.includes('\n\n\n'));
  });

  await t.test('Whitespace wird auf einfache Leerzeichen normalisiert', () => {
    const html = `<html><body><p>Viele    Leerzeichen\t\tund\n\nZeilenumbrueche ${longParagraph()}</p></body></html>`;
    const result = extractReadableText(Buffer.from(html));
    assert.ok(!/ {2,}/.test(result.text));
  });
});
