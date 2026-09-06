'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail, sha256 } = require('../utils/signingProtocol');
const { validateIdentity } = require('../utils/cmsSignature');

function readProtected(filePath) {
  if (!path.isAbsolute(String(filePath || ''))) fail('evidence_key_configuration_missing');
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('evidence_key_file_insecure');
  return fs.readFileSync(filePath, 'utf8');
}
function keyBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) fail('evidence_key_invalid');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) fail('evidence_key_invalid');
  return key;
}
function assertPurposeSeparation(keys) {
  const known = ['JWT_SECRET', 'AUTH_IDENTITY_SECRET', 'AUTH_IDENTITY_LEGACY_SECRET', 'PDF_SIGNING_KEY_ENCRYPTION_KEY'];
  const values = known.map(name => process.env[name]).filter(Boolean);
  if (process.env.PDF_SIGNING_KEY_DECRYPTION_KEYS_JSON) values.push(...Object.values(JSON.parse(process.env.PDF_SIGNING_KEY_DECRYPTION_KEYS_JSON)));
  for (const value of values) {
    const raw = String(value);
    const candidates = [Buffer.from(raw, 'utf8'), crypto.createHash('sha256').update(raw).digest()];
    if (raw.startsWith('base64:')) candidates.push(Buffer.from(raw.slice(7), 'base64'));
    if (raw.startsWith('hex:')) candidates.push(Buffer.from(raw.slice(4), 'hex'));
    if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) candidates.push(Buffer.from(raw, 'base64'));
    if (keys.some(key => candidates.some(candidate => key.equals(candidate)))) fail('evidence_key_reused');
  }
}
function loadKeyring(options = {}) {
  try {
    const config = JSON.parse(readProtected(options.path || process.env.AUDIT_EVIDENCE_KEYRING_PATH));
    if (!config || !/^[A-Za-z0-9._-]{1,32}$/.test(config.activeVersion) || !config.versions) fail('evidence_key_invalid');
    const versions = new Map();
    for (const [version, row] of Object.entries(config.versions)) {
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) fail('evidence_key_invalid');
      const hmacKey = keyBytes(row.hmacKey);
      const encryptionKey = keyBytes(row.encryptionKey);
      if (hmacKey.equals(encryptionKey)) fail('evidence_key_reused');
      assertPurposeSeparation([hmacKey, encryptionKey]);
      const certificatePem = readProtected(row.certificatePath);
      const certificate = new crypto.X509Certificate(certificatePem);
      const privateKeyPem = options.forSigning !== false && version === config.activeVersion ? readProtected(row.privateKeyPath) : '';
      const identity = { certificatePem, privateKeyPem, certificateChainPem: row.certificateChainPath ? readProtected(row.certificateChainPath) : '' };
      if (privateKeyPem) validateIdentity(identity);
      let documentIdentity = identity;
      if (row.documentCertificatePath) {
        documentIdentity = { certificatePem: readProtected(row.documentCertificatePath),
          privateKeyPem: options.forSigning !== false && version === config.activeVersion ? readProtected(row.documentPrivateKeyPath) : '',
          certificateChainPem: row.documentCertificateChainPath ? readProtected(row.documentCertificateChainPath) : '' };
        if (documentIdentity.privateKeyPem) validateIdentity(documentIdentity);
      }
      versions.set(version, { version, hmacKey, encryptionKey, identity,
        fingerprint: sha256(certificate.raw), documentIdentity,
        documentFingerprint: sha256(new crypto.X509Certificate(documentIdentity.certificatePem).raw), revoked: row.revoked === true });
    }
    const active = versions.get(config.activeVersion);
    if (!active || (options.forSigning !== false && active.revoked)) fail('evidence_key_configuration_missing');
    return { active, versions };
  } catch (error) {
    if (error.code && error.code.startsWith('evidence_')) throw error;
    return fail('evidence_key_configuration_missing');
  }
}
function assertSigningReadiness() {
  const primaryPath = process.env.AUDIT_EVIDENCE_KEYRING_PATH;
  const backupPath = process.env.AUDIT_EVIDENCE_BACKUP_KEYRING_PATH;
  const current = loadKeyring();
  if (!backupPath || !primaryPath || fs.realpathSync(primaryPath) === fs.realpathSync(backupPath)) fail('evidence_backup_unavailable');
  const backup = loadKeyring({ path: backupPath });
  const primaryConfig = JSON.parse(readProtected(primaryPath));
  const backupConfig = JSON.parse(readProtected(backupPath));
  for (const [version, entry] of Object.entries(primaryConfig.versions)) {
    const copy = backupConfig.versions[version];
    if (!copy) fail('evidence_backup_mismatch');
    for (const field of ['privateKeyPath', 'certificatePath', 'certificateChainPath',
      'documentPrivateKeyPath', 'documentCertificatePath', 'documentCertificateChainPath']) {
      if (!entry[field] && !copy[field]) continue;
      if (!entry[field] || !copy[field] || fs.realpathSync(entry[field]) === fs.realpathSync(copy[field])
        || readProtected(entry[field]) !== readProtected(copy[field])) fail('evidence_backup_mismatch');
    }
  }
  if (backup.active.version !== current.active.version || backup.versions.size !== current.versions.size) fail('evidence_backup_mismatch');
  for (const [version, key] of current.versions) {
    const other = backup.versions.get(version);
    if (!other || !key.hmacKey.equals(other.hmacKey) || !key.encryptionKey.equals(other.encryptionKey)
      || key.fingerprint !== other.fingerprint || key.documentFingerprint !== other.documentFingerprint) fail('evidence_backup_mismatch');
  }
  return { ready: true, activeVersion: current.active.version, versionCount: current.versions.size };
}

module.exports = { loadKeyring, assertSigningReadiness };
