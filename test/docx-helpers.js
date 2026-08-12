'use strict';

/**
 * Test-Hilfsfunktionen zum Entpacken eines DOCX-Buffers (DOCX ist ein ZIP),
 * OHNE neue npm-Abhaengigkeit. Nutzt zlib.inflateRawSync direkt auf die
 * rohen ZIP-Local-File-Header-Eintraege.
 *
 * Nur fuer Testzwecke gedacht (kein produktiver ZIP-Reader): keine
 * Unterstuetzung fuer ZIP64, verschluesselte Eintraege oder Data-Descriptor-
 * Streaming-Modus, da von der `docx`-Bibliothek erzeugte Dateien diese
 * Merkmale nicht nutzen.
 */

const zlib = require('zlib');

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;

// Kompressionsmethoden lt. ZIP-Spezifikation.
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

/**
 * Iteriert ueber alle Local-File-Header-Eintraege im ZIP-Buffer und ruft
 * fuer jeden gefundenen Eintrag den Callback mit {name, buffer} auf.
 * @param {Buffer} docxBuffer
 * @param {function({name:string, buffer:Buffer}):boolean} onEntry
 *        Callback; wird solange aufgerufen, bis er `true` zurueckgibt
 *        (= gefunden, Iteration abbrechen) oder das Ende erreicht ist.
 * @returns {{name:string, buffer:Buffer}|null}
 */
function iterateZipEntries(docxBuffer, onEntry) {
  if (!Buffer.isBuffer(docxBuffer)) {
    throw new TypeError('docxBuffer muss ein Buffer sein');
  }

  const signatureBytes = Buffer.alloc(4);
  signatureBytes.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);

  let searchFrom = 0;
  while (searchFrom < docxBuffer.length) {
    const offset = docxBuffer.indexOf(signatureBytes, searchFrom);
    if (offset === -1) break;
    if (offset + LOCAL_FILE_HEADER_FIXED_SIZE > docxBuffer.length) break;

    const compressionMethod = docxBuffer.readUInt16LE(offset + 8);
    const compressedSize = docxBuffer.readUInt32LE(offset + 18);
    const nameLength = docxBuffer.readUInt16LE(offset + 26);
    const extraLength = docxBuffer.readUInt16LE(offset + 28);

    const nameStart = offset + LOCAL_FILE_HEADER_FIXED_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > docxBuffer.length) break;
    const name = docxBuffer.toString('utf8', nameStart, nameEnd);

    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > docxBuffer.length) break;

    const compressed = docxBuffer.subarray(dataStart, dataEnd);
    let content;
    if (compressionMethod === COMPRESSION_STORED) {
      content = Buffer.from(compressed);
    } else if (compressionMethod === COMPRESSION_DEFLATE) {
      content = zlib.inflateRawSync(compressed);
    } else {
      content = null; // nicht unterstuetzte Kompressionsmethode
    }

    if (content !== null) {
      const stop = onEntry({ name, buffer: content });
      if (stop) return { name, buffer: content };
    }

    searchFrom = dataEnd > offset ? dataEnd : offset + 4;
  }

  return null;
}

/**
 * Liefert den rohen Inhalt eines beliebigen Teils aus dem DOCX-ZIP,
 * z.B. 'word/document.xml'.
 * @param {Buffer} docxBuffer
 * @param {string} partName
 * @returns {string}
 */
function getPart(docxBuffer, partName) {
  if (typeof partName !== 'string' || !partName) {
    throw new Error(`Ungueltiger partName: ${String(partName)}`);
  }
  const found = iterateZipEntries(docxBuffer, (entry) => entry.name === partName);
  if (!found) {
    throw new Error(`DOCX-Teil nicht gefunden: ${partName}`);
  }
  return found.buffer.toString('utf8');
}

/**
 * Kurzform fuer getPart(buffer, 'word/document.xml').
 * @param {Buffer} docxBuffer
 * @returns {string}
 */
function getDocumentXml(docxBuffer) {
  return getPart(docxBuffer, 'word/document.xml');
}

module.exports = { getPart, getDocumentXml };
