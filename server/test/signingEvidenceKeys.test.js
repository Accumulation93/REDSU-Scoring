'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { provision } = require('../scripts/provisionSigningEvidence');
const { loadKeyring, assertSigningReadiness } = require('../src/modules/audit/services/signingEvidenceKeys');
const { createReceipt, verifyReceipt } = require('../src/modules/audit/services/signingEvidenceProtocol');
const { sha256 } = require('../src/modules/audit/utils/signingProtocol');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whusu-evidence-keys-'));
const primary = path.join(root, 'primary', 'keyring.json');
const backup = path.join(root, 'backup', 'keyring.json');
try {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('base64');
  assert.equal(provision(primary, backup).ready, true);
  const original = fs.readFileSync(primary, 'utf8');
  const originalBackup = fs.readFileSync(backup, 'utf8');
  assert.equal(provision(primary, backup).ready, true);
  assert.equal(fs.readFileSync(primary, 'utf8'), original);
  const config = JSON.parse(original);
  assert.equal(loadKeyring().active.identity.privateKeyPem.includes('PRIVATE KEY'), true);
  const opts = { actor: { person_id: 'person-a', assignment_id: 'assignment-a', name: '同名', student_id: '20990001' },
    organizationId: 'org-a', eventId: 'event-a', fileId: 'file-a', submissionId: 'case-a',
    action: 'pass', time: new Date().toISOString(), round: 1, step: 1,
    inputDigest: sha256('before'), outputDigest: sha256('after'), outputDigestType: 'file_sha256', materialsDigest: sha256('[]') };
  const receipt = createReceipt(opts);
  const row = { id: receipt.ref, key_version: receipt.keyVersion, certificate_fingerprint: receipt.fingerprint,
    identity_ciphertext: receipt.identityCiphertext, receipt_digest: receipt.receiptDigest,
    payload_json: receipt.payload, input_digest: opts.inputDigest, output_digest: opts.outputDigest,
    output_digest_type: opts.outputDigestType, previous_digest: '', signed_at: opts.time, action_type: opts.action,
    org_id: opts.organizationId, person_id: opts.actor.person_id, assignment_id: opts.actor.assignment_id,
    event_id: opts.eventId, file_id: opts.fileId, submission_id: opts.submissionId };
  assert.equal(verifyReceipt(receipt.cms, row).ok, true);
  // 备份必须独立；另一份清单仍指向主文件不算备份。
  fs.writeFileSync(backup, original);
  assert.throws(assertSigningReadiness);
  fs.writeFileSync(backup, originalBackup);
  const secondPrimary = path.join(root, 'next-primary', 'keyring.json');
  const secondBackup = path.join(root, 'next-backup', 'keyring.json');
  provision(secondPrimary, secondBackup);
  const second = JSON.parse(fs.readFileSync(secondPrimary, 'utf8'));
  config.versions.v2 = second.versions.v1;
  config.activeVersion = 'v2';
  fs.writeFileSync(primary, JSON.stringify(config));
  process.env.AUDIT_EVIDENCE_KEYRING_PATH = primary;
  process.env.AUDIT_EVIDENCE_BACKUP_KEYRING_PATH = backup;
  assert.throws(assertSigningReadiness, /evidence_backup_mismatch/);
  const nextBackup = JSON.parse(originalBackup);
  nextBackup.versions.v2 = JSON.parse(fs.readFileSync(secondBackup, 'utf8')).versions.v1;
  nextBackup.activeVersion = 'v2';
  fs.writeFileSync(backup, JSON.stringify(nextBackup));
  assert.equal(assertSigningReadiness().versionCount, 2);
  assert.equal(verifyReceipt(receipt.cms, row).ok, true, '轮换后旧凭证仍可验证');
  const oldKey = config.versions.v1.privateKeyPath;
  fs.renameSync(oldKey, oldKey + '.held');
  assert.equal(verifyReceipt(receipt.cms, row).ok, true, '只读核验不要求旧私钥');
  assert.throws(assertSigningReadiness, undefined, '完整恢复备份要求旧私钥仍保留');
  fs.renameSync(oldKey + '.held', oldKey);
  delete config.versions.v1;
  fs.writeFileSync(primary, JSON.stringify(config));
  assert.equal(verifyReceipt(receipt.cms, row).reasonCode, 'evidence_key_unavailable');
  config.versions.v2.hmacKey = process.env.JWT_SECRET;
  fs.writeFileSync(primary, JSON.stringify(config));
  assert.throws(() => loadKeyring(), /evidence_key_reused/);
  console.log('签署密钥测试通过：幂等生成、独立备份、用途分离、轮换、旧私钥及历史密钥缺失失败关闭');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
