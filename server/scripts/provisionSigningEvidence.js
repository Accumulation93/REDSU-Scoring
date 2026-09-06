'use strict';

process.umask(0o077);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const { createSignerCertificate, getConfiguredSigningIdentity } = require('../src/modules/audit/utils/pdfSignature');
const { loadKeyring, assertSigningReadiness } = require('../src/modules/audit/services/signingEvidenceKeys');
const { fail } = require('../src/modules/audit/utils/signingProtocol');

function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) fail('evidence_provision_path_invalid');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('evidence_provision_path_invalid');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) fail('evidence_key_file_insecure');
}
function writeNew(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function provision(primary, backup) {
  if (!path.isAbsolute(primary || '') || !path.isAbsolute(backup || '')
    || path.dirname(primary) === path.dirname(backup)) fail('evidence_provision_path_invalid');
  privateDirectory(path.dirname(primary));
  privateDirectory(path.dirname(backup));
  if (!fs.existsSync(primary)) {
    // 仅首次初始化；已有部分密钥但缺少清单时拒绝重生成，避免覆盖无法恢复的签署事实。
    if (fs.readdirSync(path.dirname(primary)).length) fail('evidence_provision_incomplete');
    const version = 'v1';
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const cert = createSignerCertificate(forge.pki.privateKeyFromPem(pair.privateKey), forge.pki.publicKeyFromPem(pair.publicKey),
      'WHUSU Platform Attestation', '', 'WHUSU Smart Workspace');
    const row = { hmacKey: crypto.randomBytes(32).toString('base64'), encryptionKey: crypto.randomBytes(32).toString('base64'),
      certificatePath: path.join(path.dirname(primary), 'v1-certificate.pem'), privateKeyPath: path.join(path.dirname(primary), 'v1-private.pem') };
    writeNew(row.privateKeyPath, pair.privateKey);
    writeNew(row.certificatePath, cert);
    const existingDocumentIdentity = getConfiguredSigningIdentity();
    if (existingDocumentIdentity) {
      row.documentPrivateKeyPath = path.join(path.dirname(primary), 'v1-document-private.pem');
      row.documentCertificatePath = path.join(path.dirname(primary), 'v1-document-certificate.pem');
      writeNew(row.documentPrivateKeyPath, existingDocumentIdentity.privateKeyPem);
      writeNew(row.documentCertificatePath, existingDocumentIdentity.certificatePem);
      if (existingDocumentIdentity.certificateChainPem) {
        row.documentCertificateChainPath = path.join(path.dirname(primary), 'v1-document-chain.pem');
        writeNew(row.documentCertificateChainPath, existingDocumentIdentity.certificateChainPem);
      }
    }
    writeNew(primary, JSON.stringify({ activeVersion: version, versions: { [version]: row } }));
  }
  loadKeyring({ path: primary });
  if (!fs.existsSync(backup)) {
    if (fs.readdirSync(path.dirname(backup)).length) fail('evidence_backup_incomplete');
    const config = JSON.parse(fs.readFileSync(primary, 'utf8'));
    const paths = ['certificatePath', 'privateKeyPath', 'certificateChainPath', 'documentCertificatePath', 'documentPrivateKeyPath', 'documentCertificateChainPath'];
    for (const [version, row] of Object.entries(config.versions)) {
      for (const key of paths) {
        if (!row[key]) continue;
        const target = path.join(path.dirname(backup), version + '-' + key + '.pem');
        writeNew(target, fs.readFileSync(row[key]));
        row[key] = target;
      }
    }
    writeNew(backup, JSON.stringify(config));
  }
  process.env.AUDIT_EVIDENCE_KEYRING_PATH = primary;
  process.env.AUDIT_EVIDENCE_BACKUP_KEYRING_PATH = backup;
  return assertSigningReadiness();
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  try {
    const result = provision(process.env.AUDIT_EVIDENCE_KEYRING_PATH, process.env.AUDIT_EVIDENCE_BACKUP_KEYRING_PATH);
    process.stdout.write(JSON.stringify({ status: 'ready', ...result }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'blocked', reasonCode: /^evidence_[a-z_]+$/.test(error.code || '')
      ? error.code : 'evidence_provision_failed' }) + '\n');
    process.exitCode = 1;
  }
}
module.exports = { provision };
