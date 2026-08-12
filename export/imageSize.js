'use strict';

/**
 * Liest die intrinsischen Pixel-Masse (Breite/Hoehe) direkt aus den
 * Roh-Bytes eines Bildes, ohne eine externe Bildverarbeitungs-Bibliothek zu
 * benoetigen. Unterstuetzt PNG, JPEG, GIF und WebP (WebP nur zur
 * Erkennung/Groessenermittlung -- WebP wird von export/html/media.js NICHT
 * eingebettet, siehe dortige Begruendung).
 *
 * Sicherheits-/Performance-Grenze: es werden hoechstens die ersten 64 KB des
 * Buffers untersucht, damit absichtlich riesige oder korrupte Dateien den
 * Export nicht verlangsamen oder unnoetig viel Speicher binden. Wirft NIE --
 * bei jedem Fehler (unbekanntes Format, kaputte/zu kurze Daten) wird `null`
 * zurueckgegeben.
 */

const MAX_READ_BYTES = 64 * 1024;

/**
 * @param {Buffer} buffer
 * @returns {{width:number, height:number}|null}
 */
function imageSize(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const head = buffer.length > MAX_READ_BYTES ? buffer.subarray(0, MAX_READ_BYTES) : buffer;

    return (
      readPng(head) ||
      readGif(head) ||
      readJpeg(head) ||
      readWebp(head) ||
      null
    );
  } catch {
    return null;
  }
}

/** PNG: 8-Byte-Signatur, gefolgt vom IHDR-Chunk (Breite/Hoehe je 4 Byte BE). */
function readPng(buf) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(SIGNATURE)) return null;
  // Bytes 8-11: Chunk-Laenge, 12-15: 'IHDR'
  const chunkType = buf.toString('ascii', 12, 16);
  if (chunkType !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return valid(width, height);
}

/** GIF: Signatur 'GIF87a'/'GIF89a', dann Breite/Hoehe je 2 Byte LE. */
function readGif(buf) {
  if (buf.length < 10) return null;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return valid(width, height);
}

/** JPEG: SOI (0xFFD8), dann Marker-Segmente scannen bis ein SOFn gefunden wird. */
function readJpeg(buf) {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buf[offset + 1];
    // Padding-Bytes 0xFF ueberspringen.
    let markerOffset = offset + 1;
    while (marker === 0xff && markerOffset + 1 < buf.length) {
      markerOffset += 1;
      marker = buf[markerOffset];
    }
    offset = markerOffset + 1;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Marker ohne Laengenfeld.
      continue;
    }
    if (marker === 0xd9) break; // EOI
    if (offset + 1 >= buf.length) break;

    const segmentLength = buf.readUInt16BE(offset);
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSof) {
      if (offset + 7 >= buf.length) return null;
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      return valid(width, height);
    }

    if (segmentLength < 2) return null; // korrupt
    offset += segmentLength;
  }
  return null;
}

/**
 * WebP: RIFF-Container mit 'WEBP'-Fourcc, danach ein VP8-/VP8L-/VP8X-Chunk.
 * Nur zur Format-/Groessenerkennung -- WebP wird nie eingebettet.
 */
function readWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunkFourCc = buf.toString('ascii', 12, 16);
  if (chunkFourCc === 'VP8X') {
    // Chunk-Header ('VP8X' + 4-Byte Chunk-Groesse) belegt Offset 12-19,
    // Chunk-Daten beginnen daher erst bei Offset 20: 1 Byte Flags, 3 Byte
    // reserviert, dann Breite-1/Hoehe-1 je 3 Byte LE (24 Bit).
    if (buf.length < 30) return null;
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return valid(width, height);
  }
  if (chunkFourCc === 'VP8 ') {
    // Chunk-Daten beginnen bei Offset 20: 3-Byte Frame-Tag, 3-Byte Start-Code
    // (0x9d 0x01 0x2a), dann Breite/Hoehe je 2 Byte LE (14 Bit).
    if (buf.length < 30) return null;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const widthField = buf.readUInt16LE(26);
    const heightField = buf.readUInt16LE(28);
    const width = widthField & 0x3fff;
    const height = heightField & 0x3fff;
    return valid(width, height);
  }
  if (chunkFourCc === 'VP8L') {
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return valid(width, height);
  }
  return null;
}

/** @returns {{width:number,height:number}|null} */
function valid(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

module.exports = { imageSize };
