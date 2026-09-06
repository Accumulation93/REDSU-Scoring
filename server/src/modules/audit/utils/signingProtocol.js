'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 2;
// UUID f19b9f3f-2ac4-4dce-a750-926c00b162cf 的固定 OID，禁止更换或挪作其他协议。
const EVIDENCE_OID = '2.25.321151982904974529973936122011384373967';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RECEIPTS = 256;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

class SigningProtocolError extends Error {
  constructor(code) { super(code); this.name = 'SigningProtocolError'; this.code = code; }
}
function fail(code) { throw new SigningProtocolError(code); }

// RFC 8785：UTF-16 键排序、ECMAScript JSON 数字/字符串序列化，不做 Unicode 归一化。
function canonicalize(value, depth = 0) {
  if (depth > 24) fail('evidence_depth_exceeded');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('evidence_number_invalid');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('evidence_unicode_invalid');
      } else if (code >= 0xdc00 && code <= 0xdfff) fail('evidence_unicode_invalid');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(item => canonicalize(item, depth + 1)).join(',') + ']';
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('evidence_type_invalid');
  return '{' + Object.keys(value).sort().map(key => canonicalize(key, depth + 1) + ':' + canonicalize(value[key], depth + 1)).join(',') + '}';
}
function canonicalBytes(value) { return Buffer.from(canonicalize(value), 'utf8'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function equalHex(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a)
    && /^[a-f0-9]{64}$/.test(b) && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function decodeBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 !== 0) fail('evidence_encoding_invalid');
  // 线性扫描避免重复分组正则在接近文件上限时耗尽调用栈；回编码继续校验填充位。
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let i = 0; i < value.length - padding; i += 1) {
    const code = value.charCodeAt(i);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) fail('evidence_encoding_invalid');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) fail('evidence_encoding_invalid');
  return bytes;
}
function assertManifest(manifest) {
  if (!manifest || manifest.version !== PROTOCOL_VERSION || !Array.isArray(manifest.receipts)
    || Object.keys(manifest).sort().join(',') !== 'legacyPrefix,receipts,version'
    || !manifest.receipts.length || manifest.receipts.length > MAX_RECEIPTS
    || typeof manifest.legacyPrefix !== 'boolean') fail('evidence_manifest_invalid');
  const bytes = canonicalBytes(manifest);
  if (bytes.length > MAX_MANIFEST_BYTES) fail('evidence_manifest_too_large');
  return bytes;
}

module.exports = { PROTOCOL_VERSION, EVIDENCE_OID, MAX_MANIFEST_BYTES, MAX_RECEIPTS, MAX_FILE_BYTES,
  SigningProtocolError, fail, canonicalize, canonicalBytes, sha256, equalHex, decodeBase64, assertManifest };
