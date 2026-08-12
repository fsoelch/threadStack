'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { Document, Packer, ImageRun } = require('docx');

const { getDocumentXml } = require('./docx-helpers');
const docxTheme = require('../export/docxTheme');
const { createRenderContext } = require('../export/html/context');
const { buildImageBlocks } = require('../export/html/media');
const { imageSize } = require('../export/imageSize');

// ---------------------------------------------------------------------------
// Hand gebaute, ECHTE Bild-Bytes (kein Mock von imageSize/buildImageBlocks).
// ---------------------------------------------------------------------------

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}

/** Baut ein valides, minimales unkomprimiertes (per zlib.deflate) RGB-PNG. */
function buildPng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  const ihdr = pngChunk('IHDR', ihdrData);
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height, 0);
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** Baut einen validen GIF-Logical-Screen-Descriptor (Header ausreichend fuer imageSize). */
function buildGif(width, height) {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** Baut einen minimalen, aber spezifikationskonformen JPEG-Header (SOI/APP0/SOF0/EOI). */
function buildJpeg(width, height) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof0Data = Buffer.alloc(11);
  sof0Data.writeUInt16BE(11, 0);
  sof0Data[2] = 8;
  sof0Data.writeUInt16BE(height, 3);
  sof0Data.writeUInt16BE(width, 5);
  sof0Data[7] = 1;
  sof0Data[8] = 1;
  sof0Data[9] = 0x11;
  sof0Data[10] = 0;
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), sof0Data]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, eoi]);
}

/** Baut einen minimalen validen WebP-Container mit VP8X-Chunk (Erkennung, kein Einbetten). */
function buildWebpVp8x(width, height) {
  const chunkData = Buffer.alloc(10);
  chunkData[0] = 0x10; // flags
  const w = width - 1;
  const h = height - 1;
  chunkData[4] = w & 0xff;
  chunkData[5] = (w >> 8) & 0xff;
  chunkData[6] = (w >> 16) & 0xff;
  chunkData[7] = h & 0xff;
  chunkData[8] = (h >> 8) & 0xff;
  chunkData[9] = (h >> 16) & 0xff;
  const vp8x = Buffer.concat([Buffer.from('VP8X', 'ascii'), lenLe(chunkData.length), chunkData]);
  const riffPayload = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x]);
  const riff = Buffer.concat([Buffer.from('RIFF', 'ascii'), lenLe(riffPayload.length), riffPayload]);
  return riff;
}

function lenLe(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function dataUrl(mime, buffer) {
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

function makeCtx(warnSpy) {
  const numbering = docxTheme.createNumberingRegistry();
  return createRenderContext({ numbering, warn: warnSpy });
}

/** Packt einen einzelnen Paragraph in ein Mini-Dokument und liefert dessen document.xml. */
async function xmlOf(paragraph) {
  const doc = new Document({ sections: [{ children: [paragraph] }] });
  const buffer = await Packer.toBuffer(doc);
  return getDocumentXml(buffer);
}

function isImageParagraph(paragraph) {
  return paragraph.root.some((child) => child instanceof ImageRun);
}

function findImageRun(paragraph) {
  return paragraph.root.find((child) => child instanceof ImageRun);
}

/** @returns {{width:number, height:number}} Pixel-Zielmasse der Transformation. */
function dims(imageRun) {
  const pixels = imageRun.imageData.transformation.pixels;
  return { width: pixels.x, height: pixels.y };
}

// ---------------------------------------------------------------------------
// imageSize
// ---------------------------------------------------------------------------

test('imageSize: erkennt PNG-Masse aus echten IHDR-Bytes', () => {
  const png = buildPng(200, 100);
  assert.deepEqual(imageSize(png), { width: 200, height: 100 });
});

test('imageSize: erkennt JPEG-Masse aus echten SOF0-Bytes', () => {
  const jpeg = buildJpeg(150, 50);
  assert.deepEqual(imageSize(jpeg), { width: 150, height: 50 });
});

test('imageSize: erkennt GIF-Masse aus echtem Logical-Screen-Descriptor', () => {
  const gif = buildGif(40, 20);
  assert.deepEqual(imageSize(gif), { width: 40, height: 20 });
});

test('imageSize: erkennt WebP (VP8X)-Masse, wird aber nur zur Erkennung genutzt', () => {
  const webp = buildWebpVp8x(300, 150);
  assert.deepEqual(imageSize(webp), { width: 300, height: 150 });
});

test('imageSize: liefert null bei unbekanntem/korruptem Format, wirft nie', () => {
  assert.equal(imageSize(Buffer.from('nicht-ein-bild')), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
  assert.equal(imageSize(null), null);
  assert.equal(imageSize(undefined), null);
  assert.equal(imageSize('kein-buffer'), null);
});

test('imageSize: liest hoechstens 64KB (riesiger Buffer fuehrt nicht zum Absturz)', () => {
  const huge = Buffer.concat([buildPng(10, 10), Buffer.alloc(2 * 1024 * 1024, 0)]);
  assert.deepEqual(imageSize(huge), { width: 10, height: 10 });
});

// ---------------------------------------------------------------------------
// buildImageBlocks
// ---------------------------------------------------------------------------

test('buildImageBlocks: PNG im Verhaeltnis 2:1 wird mit <2% Abweichung vom Original-Seitenverhaeltnis eingebettet', async () => {
  const png = buildPng(200, 100); // Original-Ratio 2:1, unterhalb Satzspiegelbreite
  const node = { name: 'img', attribs: { src: dataUrl('png', png), alt: 'Testbild' } };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);

  assert.equal(blocks.length, 1);
  assert.ok(isImageParagraph(blocks[0]), 'sollte ein eingebettetes Bild enthalten');

  const imageRun = findImageRun(blocks[0]);
  const { width, height } = dims(imageRun);
  const originalRatio = 200 / 100;
  const embeddedRatio = width / height;
  const deviation = Math.abs(embeddedRatio - originalRatio) / originalRatio;
  assert.ok(deviation < 0.02, `Abweichung ${deviation} sollte < 2% sein`);
  // Bild ist kleiner als Satzspiegel -> keine Vergroesserung.
  assert.equal(width, 200);
  assert.equal(height, 100);
});

test('buildImageBlocks: Bild breiter als Satzspiegel wird proportional herunterskaliert', async () => {
  const png = buildPng(2000, 1000); // 2:1, deutlich breiter als contentWidthPx
  const node = { name: 'img', attribs: { src: dataUrl('png', png) } };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  const imageRun = findImageRun(blocks[0]);
  const { width, height } = dims(imageRun);

  assert.equal(width, docxTheme.PAGE.contentWidthPx);
  const originalRatio = 2000 / 1000;
  const embeddedRatio = width / height;
  const deviation = Math.abs(embeddedRatio - originalRatio) / originalRatio;
  assert.ok(deviation < 0.02, `Abweichung ${deviation} sollte < 2% sein`);
});

test('buildImageBlocks: Bild schmaler als Satzspiegel wird NICHT vergroessert', async () => {
  const png = buildPng(50, 25);
  const node = { name: 'img', attribs: { src: dataUrl('png', png) } };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  const imageRun = findImageRun(blocks[0]);
  const { width, height } = dims(imageRun);

  assert.equal(width, 50);
  assert.equal(height, 25);
});

test('buildImageBlocks: width/height-Attribute werden als Zielmasse verwendet, sofern sie die Satzspiegelbreite nicht ueberschreiten', async () => {
  const png = buildPng(200, 100); // intrinsisch 2:1
  const node = {
    name: 'img',
    attribs: { src: dataUrl('png', png), width: '300', height: '150' },
  };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  const imageRun = findImageRun(blocks[0]);
  const { width, height } = dims(imageRun);

  assert.equal(width, 300);
  assert.equal(height, 150);
});

test('buildImageBlocks: width-Attribut, das die Satzspiegelbreite ueberschreitet, wird ignoriert (Fallback auf intrinsische Masse + Skalierung)', async () => {
  const png = buildPng(2000, 1000);
  const node = {
    name: 'img',
    attribs: { src: dataUrl('png', png), width: '5000', height: '2500' },
  };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  const imageRun = findImageRun(blocks[0]);
  const { width } = dims(imageRun);

  assert.equal(width, docxTheme.PAGE.contentWidthPx);
});

test('buildImageBlocks: ungueltiges Base64 -> Platzhalter mit alt-Text, kein throw, Export bleibt lauffaehig', async () => {
  const node = {
    name: 'img',
    attribs: { src: 'data:image/png;base64,!!!nicht-valides-base64!!!', alt: 'Kaputtes Bild' },
  };
  const warned = [];
  const ctx = makeCtx((code) => warned.push(code));

  let blocks;
  assert.doesNotThrow(() => {
    blocks = buildImageBlocks(node, ctx);
  });
  assert.equal(blocks.length, 1);
  assert.ok(!isImageParagraph(blocks[0]));
  const xml = await xmlOf(blocks[0]);
  assert.match(xml, /Kaputtes Bild/);
  assert.deepEqual(warned, ['IMG_DECODE_FAILED']);
});

test('buildImageBlocks: WebP-data-URL fuehrt zu Platzhalter (wird NICHT als PNG durchgereicht)', async () => {
  const webp = buildWebpVp8x(100, 50);
  const node = { name: 'img', attribs: { src: dataUrl('webp', webp), alt: 'WebP-Bild' } };
  const warned = [];
  const ctx = makeCtx((code) => warned.push(code));
  const blocks = buildImageBlocks(node, ctx);

  assert.equal(blocks.length, 1);
  assert.ok(!isImageParagraph(blocks[0]), 'WebP darf NIE als eingebettetes Bild (z.B. faelschlich als PNG) landen');
  const xml = await xmlOf(blocks[0]);
  assert.match(xml, /WebP-Bild/);
  assert.deepEqual(warned, ['IMG_UNSUPPORTED_FORMAT']);
});

test('buildImageBlocks: unbekanntes/fehlendes Format fuehrt zu Platzhalter', async () => {
  const warned1 = [];
  const ctx1 = makeCtx((code) => warned1.push(code));
  const blocksNoSrc = buildImageBlocks({ name: 'img', attribs: {} }, ctx1);
  assert.equal(blocksNoSrc.length, 1);
  assert.ok(!isImageParagraph(blocksNoSrc[0]));
  assert.deepEqual(warned1, ['IMG_UNSUPPORTED_FORMAT']);

  const warned2 = [];
  const ctx2 = makeCtx((code) => warned2.push(code));
  const blocksExternal = buildImageBlocks(
    { name: 'img', attribs: { src: 'https://example.com/tracking-pixel.png' } },
    ctx2,
  );
  assert.equal(blocksExternal.length, 1);
  assert.ok(!isImageParagraph(blocksExternal[0]), 'externe URLs duerfen NIE nachgeladen werden (kein SSRF)');
  assert.deepEqual(warned2, ['IMG_UNSUPPORTED_FORMAT']);
});

test('buildImageBlocks: nicht lesbare Bildmasse (unbekanntes Binaerformat unter zulaessigem MIME-Typ) fuehrt zu Platzhalter', async () => {
  const garbage = Buffer.from('DIES-IST-KEIN-GUELTIGES-BILDFORMAT-AUCH-WENN-DER-MIME-TYP-PNG-IST');
  const node = { name: 'img', attribs: { src: dataUrl('png', garbage), alt: 'Unlesbar' } };
  const warned = [];
  const ctx = makeCtx((code) => warned.push(code));
  const blocks = buildImageBlocks(node, ctx);

  assert.equal(blocks.length, 1);
  assert.ok(!isImageParagraph(blocks[0]));
  assert.deepEqual(warned, ['IMG_DIMENSIONS_UNKNOWN']);
});

test('buildImageBlocks: alt-Text landet im altText-Feld des eingebetteten Bildes', async () => {
  const png = buildPng(20, 10);
  const node = { name: 'img', attribs: { src: dataUrl('png', png), alt: 'Barrierefreier Alt-Text' } };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  assert.ok(isImageParagraph(blocks[0]));

  const xml = await xmlOf(blocks[0]);
  // docPr traegt name/descr/title -- alle drei sollen den alt-Text enthalten
  // (Barrierefreiheit gemaess Schnittstellenvertrag).
  const docPr = xml.match(/<wp:docPr[^/]*\/>/)[0];
  assert.match(docPr, /name="Barrierefreier Alt-Text"/);
  assert.match(docPr, /title="Barrierefreier Alt-Text"/);
  assert.match(docPr, /descr="Barrierefreier Alt-Text/);
});

test('buildImageBlocks: fehlender alt-Text -> Platzhaltertext ohne ": <alt>"-Suffix, Default-altText "Bild"', async () => {
  const node = { name: 'img', attribs: { src: 'data:image/gif;base64,!!!invalid!!!' } };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  const xml = await xmlOf(blocks[0]);
  assert.match(xml, /\[Bild konnte nicht eingebettet werden\]/);
});

test('buildImageBlocks: wirft NIE, auch bei komplett fehlerhaftem node/ctx', () => {
  assert.doesNotThrow(() => {
    const blocks = buildImageBlocks(null, {});
    assert.equal(blocks.length, 1);
  });
  assert.doesNotThrow(() => {
    const blocks = buildImageBlocks({ name: 'img' }, {});
    assert.equal(blocks.length, 1);
  });
  assert.doesNotThrow(() => {
    const blocks = buildImageBlocks({ name: 'img', attribs: { src: 42 } }, {});
    assert.equal(blocks.length, 1);
  });
});

test('buildImageBlocks: JPEG (jpeg-MIME) wird mit docx-Typ "jpg" eingebettet', async () => {
  const jpeg = buildJpeg(120, 60);
  const node = { name: 'img', attribs: { src: dataUrl('jpeg', jpeg) } };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  const imageRun = findImageRun(blocks[0]);
  assert.ok(isImageParagraph(blocks[0]));
  assert.equal(imageRun.imageData.type, 'jpg');
});

test('buildImageBlocks: GIF wird mit docx-Typ "gif" eingebettet', async () => {
  const gif = buildGif(40, 20);
  const node = { name: 'img', attribs: { src: dataUrl('gif', gif) } };
  const ctx = makeCtx(() => {});
  const blocks = buildImageBlocks(node, ctx);
  const imageRun = findImageRun(blocks[0]);
  assert.ok(isImageParagraph(blocks[0]));
  assert.equal(imageRun.imageData.type, 'gif');
});
