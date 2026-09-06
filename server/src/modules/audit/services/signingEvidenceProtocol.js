'use strict';

const crypto = require('crypto');
const { canonicalBytes, canonicalize, sha256, equalHex, fail, decodeBase64, MAX_RECEIPTS, assertManifest } = require('../utils/signingProtocol');
const { signCms, verifyCms, MAX_CMS_BYTES } = require('../utils/cmsSignature');
const { loadKeyring } = require('./signingEvidenceKeys');

function privateIdentity(actor, organizationId) {
  const identity = { personId: String(actor.person_id || ''), name: String(actor.name || ''),
    studentId: String(actor.student_id || ''), organizationId: String(organizationId || ''),
    assignmentId: String(actor.assignment_id || ''), contextId: String(actor.contextId || actor.context_id || '') };
  if (!identity.personId || !identity.assignmentId || !identity.organizationId || !identity.name || !identity.studentId) fail('evidence_identity_missing');
  return identity;
}
function aad(organizationId, ref) { return canonicalBytes({ purpose: 'WHUSU-PDF-IDENTITY', version: 2, organizationId, ref }); }
function commitment(key, identity, claims) {
  return crypto.createHmac('sha256', key).update(canonicalBytes({ purpose: 'WHUSU-PDF-SIGNER', version: 2, identity, claims })).digest('hex');
}
function validatePayload(p) {
  const expected = ['version', 'ref', 'keyVersion', 'name', 'organization', 'assignment', 'action', 'time',
    'round', 'step', 'previous', 'inputDigest', 'inputDigestType', 'outputDigest', 'outputDigestType',
    'materialsDigest', 'binding', 'identityCommitment'];
  if (!p || Object.keys(p).length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(p, key))
    || p.version !== 2 || !/^[A-Za-z0-9._-]{1,32}$/.test(p.keyVersion)
    || !['approve', 'pass', 'sign', 'stamp', 'both', 'estamp', 'reject'].includes(p.action)
    || !Number.isInteger(p.round) || p.round < 1 || !Number.isInteger(p.step) || p.step < 1 || p.step > 256
    || !['file_sha256', 'pdf_byte_range_sha256'].includes(p.outputDigestType) || p.inputDigestType !== 'file_sha256'
    || !['name', 'organization', 'assignment'].every(key => typeof p[key] === 'string' && p[key].length <= 1024)
    || !p.name || typeof p.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.time)
    || !Number.isFinite(Date.parse(p.time))
    || !['ref', 'inputDigest', 'outputDigest', 'materialsDigest', 'binding', 'identityCommitment'].every(key => typeof p[key] === 'string' && /^[a-f0-9]{64}$/.test(p[key]))
    || (p.previous !== '' && !/^[a-f0-9]{64}$/.test(p.previous))) fail('evidence_payload_invalid');
}
function createReceipt(options, keyring = loadKeyring()) {
  const active = keyring.active;
  if (!active || active.revoked) fail('evidence_key_unavailable');
  const identity = privateIdentity(options.actor, options.organizationId);
  const ref = crypto.randomBytes(32).toString('hex');
  const claims = { version: 2, ref, keyVersion: active.version, name: identity.name,
    organization: String(options.organizationName || ''), assignment: String(options.assignmentLabel || ''),
    action: options.action, time: options.time, round: options.round, step: options.step,
    previous: options.previous || '', inputDigest: options.inputDigest, inputDigestType: 'file_sha256', outputDigest: options.outputDigest,
    outputDigestType: options.outputDigestType, materialsDigest: options.materialsDigest,
    // 业务主键不公开；随机盐参与 HMAC，防止根据已知姓名/学号进行离线枚举。
    binding: crypto.createHmac('sha256', active.hmacKey).update(canonicalBytes({ ref,
      eventId: options.eventId, fileId: options.fileId, submissionId: options.submissionId })).digest('hex') };
  const payload = { ...claims, identityCommitment: commitment(active.hmacKey, identity, claims) };
  validatePayload(payload);
  const content = canonicalBytes(payload);
  const cms = signCms(content, active.identity, { encapsulated: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', active.encryptionKey, iv);
  cipher.setAAD(aad(identity.organizationId, ref));
  const encrypted = Buffer.concat([cipher.update(canonicalBytes(identity)), cipher.final()]);
  return { ref, payload, cms: cms.toString('base64'), receiptDigest: sha256(cms),
    fingerprint: active.fingerprint, keyVersion: active.version,
    identityCiphertext: canonicalize({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }) };
}
function verifyReceipt(cmsBase64, row, keyring = loadKeyring({ forSigning: false })) {
  try {
    const cms = decodeBase64(cmsBase64, MAX_CMS_BYTES);
    const result = verifyCms(cms, null, { requireBinding: true });
    if (!result.ok) fail(result.reasonCode);
    const payload = JSON.parse(result.content.toString('utf8'));
    validatePayload(payload);
    if (Date.parse(payload.time) < Date.parse(result.certificateValidFrom)
      || Date.parse(payload.time) > Date.parse(result.certificateValidTo)) fail('evidence_certificate_time_invalid');
    if (!result.content.equals(canonicalBytes(payload)) || payload.version !== 2 || !/^[a-f0-9]{64}$/.test(payload.ref)) fail('evidence_payload_invalid');
    const key = keyring.versions.get(payload.keyVersion);
    if (!key) fail('evidence_key_unavailable');
    if (key.revoked) fail('evidence_key_revoked');
    if (!equalHex(key.fingerprint, result.certificateFingerprint)) fail('evidence_certificate_unregistered');
    if (!row) return { ok: false, reasonCode: 'evidence_record_unavailable', receiptDigest: sha256(cms) };
    if (row.id !== payload.ref || !equalHex(row.receipt_digest, sha256(cms))
      || row.key_version !== payload.keyVersion || !equalHex(row.certificate_fingerprint, result.certificateFingerprint)
      || !equalHex(row.input_digest, payload.inputDigest) || row.previous_digest !== payload.previous
      || row.action_type !== payload.action || new Date(row.signed_at).toISOString() !== payload.time
      || canonicalize(typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) !== canonicalize(payload)
      || !equalHex(row.output_digest, payload.outputDigest) || row.output_digest_type !== payload.outputDigestType) fail('evidence_record_mismatch');
    const encrypted = JSON.parse(row.identity_ciphertext);
    const iv = decodeBase64(encrypted.iv, 12);
    const tag = decodeBase64(encrypted.tag, 16);
    if (iv.length !== 12 || tag.length !== 16) fail('evidence_ciphertext_invalid');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key.encryptionKey, iv);
    decipher.setAAD(aad(row.org_id, payload.ref));
    decipher.setAuthTag(tag);
    const identity = JSON.parse(Buffer.concat([decipher.update(decodeBase64(encrypted.data, 65536)), decipher.final()]).toString('utf8'));
    const claims = { ...payload };
    delete claims.identityCommitment;
    const binding = crypto.createHmac('sha256', key.hmacKey).update(canonicalBytes({ ref: payload.ref,
      eventId: row.event_id, fileId: row.file_id, submissionId: row.submission_id })).digest('hex');
    if (!equalHex(binding, payload.binding) || !equalHex(commitment(key.hmacKey, identity, claims), payload.identityCommitment)
      || identity.personId !== row.person_id || identity.assignmentId !== row.assignment_id
      || identity.organizationId !== row.org_id || identity.name !== payload.name) fail('evidence_identity_mismatch');
    return { ok: true, reasonCode: 'evidence_identity_verified', payload, receiptDigest: sha256(cms),
      certificateFingerprint: result.certificateFingerprint, certificateTimeValid: result.certificateTimeValid };
  } catch (error) { return { ok: false, reasonCode: error.code || 'evidence_ciphertext_invalid' }; }
}
function buildManifest(previousRows, receipt, legacyPrefix) {
  const manifest = { version: 2, legacyPrefix: Boolean(legacyPrefix), receipts: previousRows.map(row => row.cms_base64).concat(receipt.cms) };
  assertManifest(manifest);
  return manifest;
}
function verifyManifest(manifest, rows, keyring, finalDigest) {
  try {
    const deadline = Date.now() + 5000;
    assertManifest(manifest);
    if (rows.length > MAX_RECEIPTS || rows.length !== manifest.receipts.length) fail('evidence_chain_incomplete');
    const checked = [];
    let previous = '';
    for (let index = 0; index < rows.length; index += 1) {
      if (Date.now() > deadline) fail('verification_timeout');
      const result = verifyReceipt(manifest.receipts[index], rows[index], keyring);
      if (!result.ok) return { ok: false, reasonCode: result.reasonCode, receipts: checked };
      const p = result.payload;
      if (p.previous !== previous || p.step !== Number(rows[index].step_index) || p.round !== Number(rows[index].round)
        || (index && p.step !== checked[index - 1].payload.step + 1)) fail('evidence_chain_invalid');
      if (index && !equalHex(p.inputDigest, checked[index - 1].payload.outputDigest)) fail('evidence_document_chain_invalid');
      previous = result.receiptDigest;
      checked.push(result);
    }
    const last = checked[checked.length - 1].payload;
    if (finalDigest && (last.outputDigestType !== 'pdf_byte_range_sha256' || !equalHex(last.outputDigest, finalDigest))) fail('evidence_document_mismatch');
    return { ok: true, legacyPrefix: manifest.legacyPrefix, reasonCode: manifest.legacyPrefix ? 'evidence_legacy_prefix' : 'evidence_chain_verified', receipts: checked };
  } catch (error) { return { ok: false, reasonCode: error.code || 'evidence_manifest_invalid', receipts: [] }; }
}

module.exports = { createReceipt, verifyReceipt, buildManifest, verifyManifest };
