'use strict';
const crypto = require('crypto');

// AES-256-GCM. Key is provided by the server (loaded from data/.encryption-key).

function encryptKey(plaintext, key) {
  if (!plaintext) return '';
  if (!key || key.length !== 32) throw new Error('Encryption key not initialized');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decryptKey(stored, key) {
  if (!stored) return '';
  if (!key || key.length !== 32) throw new Error('Encryption key not initialized');
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted key');
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function maskKey(plaintext) {
  if (!plaintext) return '';
  const last4 = plaintext.slice(-4);
  return '••••' + last4;
}

function last4(plaintext) {
  if (!plaintext) return '';
  return plaintext.slice(-4);
}

module.exports = { encryptKey, decryptKey, maskKey, last4 };
