'use strict';

const evidenceModel = require('../models/signingEvidence');
const fileModel = require('../models/auditSubmissionFile');
const { readStoredAuditFile } = require('../utils/fileSecurity');
const { verifyPdfBytes } = require('./pdfVerification');
const { verifyManifest } = require('./signingEvidenceProtocol');
const { loadKeyring } = require('./signingEvidenceKeys');
const { sha256, equalHex } = require('../utils/signingProtocol');
const { X509Certificate } = require('crypto');

const check = (status, reasonCode) => ({ status, reasonCode });
const unresolved = code => check('indeterminate', code);
function combine(values) {
  if (values.some(item => item.status === 'failed')) return 'failed';
  if (values.some(item => item.status === 'indeterminate')) return 'indeterminate';
  if (values.some(item => item.status === 'legacy_partial')) return 'legacy_partial';
  return values.length ? 'passed' : 'indeterminate';
}
function isUnavailable(code) {
  return /(?:unavailable|missing|configuration|timeout|busy|unsupported)$/.test(code || '');
}
function outcome(error) {
  const code = error.code || error.reasonCode || 'verification_unavailable';
  return check(isUnavailable(code) ? 'indeterminate' : 'failed', code);
}
function eventBindingsValid(rows, facts) {
  if (!rows.length) return false;
  const roundFacts = facts.filter(item => Number(item.round) === Number(rows[0].round));
  const first = Number(rows[0].step_index);
  const expected = roundFacts.filter(item => Number(item.step_index) >= first);
  if (expected.length !== rows.length) return false;
  return rows.every(row => {
    const fact = expected.find(item => item.id === row.event_id && item.step_id === row.step_id);
    return fact && fact.org_id === row.org_id && fact.submission_id === row.submission_id
      && Number(fact.step_index) === Number(row.step_index) && Number(fact.round) === Number(row.round)
      && fact.operator_person_id === row.person_id && fact.processed_person_id === row.person_id
      && fact.operator_assignment_id === row.assignment_id && fact.processed_assignment_id === row.assignment_id
      && fact.event_type === (row.action_type === 'reject' ? 'reject' : 'approve')
      && fact.step_status === (row.action_type === 'reject' ? 'rejected' : 'approved');
  });
}
function publicReceipt(checked, personIndex) {
  const p = checked.payload;
  return { reference: p.ref, name: p.name, assignment: p.assignment, organization: p.organization, personIndex,
    action: p.action, signedAt: p.time, timeSource: 'platform_recorded', round: p.round, step: p.step,
    status: 'passed', reasonCode: checked.reasonCode, algorithm: 'RSA-SHA256',
    digestAlgorithm: 'SHA-256', identityAlgorithm: 'HMAC-SHA-256', snapshotAlgorithm: 'AES-256-GCM',
    keyVersion: p.keyVersion, certificateFingerprint: checked.certificateFingerprint,
    inputDigest: p.inputDigest, outputDigest: p.outputDigest, outputDigestType: p.outputDigestType,
    previousDigest: p.previous, receiptDigest: checked.receiptDigest };
}
function publicCms(item) {
  return { status: item.cmsValid ? 'passed' : 'failed', reasonCode: item.reasonCode,
    algorithm: item.algorithm || '', certificateFingerprint: item.certificateFingerprint || '',
    certificateBound: Boolean(item.certificateBound), wholeDocument: Boolean(item.wholeDocument),
    signedBytesDigest: item.signedBytesDigest || '', byteRange: item.byteRange || [] };
}
async function verifyFile(bytes, file, context = {}) {
  const result = { fileId: file ? String(file.id) : '', fileName: file ? String(file.file_name) : '',
    currentHash: bytes ? sha256(bytes) : '', overallStatus: 'indeterminate', steps: [], cms: [],
    checks: { documentIntegrity: unresolved('file_unavailable'), cmsSignature: unresolved('pdf_unsigned'),
      receiptChain: unresolved('evidence_record_unavailable'), identityBinding: unresolved('evidence_record_unavailable'),
      platformCertificate: unresolved('evidence_certificate_unregistered'), externalTrust: unresolved('external_trust_not_evaluated') } };
  if (!bytes) return result;
  const isPdf = bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-');
  const pdf = isPdf ? await verifyPdfBytes(bytes) : { present: false, valid: false, signatures: [], reasonCode: 'not_pdf' };
  result.cms = pdf.signatures.map(publicCms);
  result.checks.cmsSignature = pdf.valid ? check('passed', 'cms_signature_valid')
    : pdf.present ? outcome({ reasonCode: pdf.signatures.find(item => !item.ok)?.reasonCode || pdf.reasonCode }) : unresolved(pdf.reasonCode);
  const matchingHash = file && equalHex(file.file_hash, result.currentHash);
  result.checks.documentIntegrity = file && !matchingHash ? check('failed', 'file_digest_mismatch')
    : pdf.valid ? check('passed', 'pdf_whole_document_verified')
      : pdf.present ? outcome({ reasonCode: pdf.signatures.find(item => !item.ok)?.reasonCode || pdf.reasonCode })
        : matchingHash ? check('passed', 'stored_file_digest_verified') : unresolved('file_record_unavailable');
  // 保留附件重提交时沿用文件 ID，但新轮次绝不能拼接上一轮的凭证。
  const rows = (context.rows || []).filter(row => file && row.file_id === file.id
    && Number(row.round) === Number(file.revision_round || 1));
  const expectsFinalPdf = rows.length && rows[rows.length - 1].output_digest_type === 'pdf_byte_range_sha256';
  const finalSignature = expectsFinalPdf && pdf.signatures.find(item => item.manifest && item.wholeDocument);
  if (rows.length) {
    try {
      if (!eventBindingsValid(rows, context.events || [])) throw { code: 'evidence_event_mismatch' };
      const keyring = context.keyring || loadKeyring({ forSigning: false });
      const manifest = finalSignature ? finalSignature.manifest
        : { version: 2, legacyPrefix: Boolean(rows[0].legacy_prefix), receipts: rows.map(row => row.cms_base64) };
      const verified = verifyManifest(manifest, rows, keyring, finalSignature && finalSignature.signedBytesDigest);
      if (!verified.ok) throw verified;
      if (manifest.legacyPrefix !== Boolean(rows[0].legacy_prefix)
        || (!manifest.legacyPrefix && Number(rows[0].step_index) !== 1)) throw { code: 'evidence_chain_invalid' };
      const certificates = context.certificates || [];
      const registered = verified.receipts.every(item => certificates.some(cert => cert.status === 'active'
        && cert.key_version === item.payload.keyVersion && equalHex(cert.certificate_fingerprint, item.certificateFingerprint)));
      if (!registered) throw { code: 'evidence_certificate_unregistered' };
      if (finalSignature && !certificates.some(cert => cert.status === 'active'
        && equalHex(cert.certificate_fingerprint, finalSignature.certificateFingerprint)
        && Array.from(keyring.versions.values()).some(key => !key.revoked
          && (equalHex(key.fingerprint, cert.certificate_fingerprint) || equalHex(key.documentFingerprint, cert.certificate_fingerprint))))) {
        throw { code: 'evidence_certificate_unregistered' };
      }
      const last = rows[rows.length - 1];
      if (!equalHex(last.final_file_digest, result.currentHash)) throw { code: 'evidence_document_mismatch' };
      if (last.output_digest_type === 'pdf_byte_range_sha256' && (!finalSignature || !pdf.valid)) throw { code: 'evidence_final_manifest_missing' };
      if (last.output_digest_type === 'file_sha256' && !equalHex(last.output_digest, result.currentHash)) throw { code: 'evidence_document_mismatch' };
      // 编号只在本次报告内区分已验真的自然人，不公开主键，也不形成跨报告追踪标识。
      const people = context.people || new Map();
      result.steps = verified.receipts.map(item => {
        const row = rows.find(value => value.id === item.payload.ref);
        if (!people.has(row.person_id)) people.set(row.person_id, people.size + 1);
        return publicReceipt(item, people.get(row.person_id));
      });
      // 只导出实际 PDF 签名使用、已登记且与受保护配置精确匹配的公开叶证书。
      result.certificates = [];
      if (finalSignature) {
        const fingerprint = finalSignature.certificateFingerprint;
        const key = Array.from(keyring.versions.values()).find(value => !value.revoked
          && (equalHex(value.documentFingerprint, fingerprint) || equalHex(value.fingerprint, fingerprint)));
        if (key) {
          const identity = equalHex(key.documentFingerprint, fingerprint) ? key.documentIdentity : key.identity;
          const certificate = new X509Certificate(identity.certificatePem);
          if (certificate.raw.length <= 65536 && equalHex(sha256(certificate.raw), fingerprint)) {
            result.certificates.push({ fingerprint, derBase64: certificate.raw.toString('base64') });
          }
        }
      }
      result.checks.identityBinding = check('passed', 'evidence_identity_verified');
      result.checks.receiptChain = check(manifest.legacyPrefix ? 'legacy_partial' : 'passed', verified.reasonCode);
      result.checks.platformCertificate = check('passed', 'platform_certificate_registered');
      // 外部 CA 和可信时间戳尚未建立验证链，不参与平台托管证明的绿色结论。
      if (!isPdf || last.output_digest_type === 'file_sha256') result.checks.cmsSignature = check('passed', 'receipt_cms_verified');
    } catch (error) {
      result.checks.receiptChain = outcome(error);
      result.checks.identityBinding = outcome(error);
    }
  } else if (pdf.valid && !pdf.signatures.some(item => item.manifest) && !context.unavailable) {
    result.checks.receiptChain = check('legacy_partial', 'legacy_evidence_insufficient');
    result.checks.identityBinding = check('legacy_partial', 'legacy_identity_not_attested');
    result.checks.platformCertificate = check('legacy_partial', 'legacy_certificate_not_registered');
  }
  result.overallStatus = combine(Object.entries(result.checks).filter(([key]) => key !== 'externalTrust').map(([, value]) => value));
  return result;
}
async function verifySubmissionFiles(submission, options = {}) {
  const files = await fileModel.getBySubmissionId(submission.id);
  const selected = options.uploadedBytes ? files.filter(file => equalHex(file.file_hash, sha256(options.uploadedBytes))) : files;
  if (options.source === 'record_lookup') return { verificationVersion: 2, verificationSource: 'record_lookup',
    overallStatus: 'indeterminate', valid: false, reasonCode: 'uploaded_file_not_verified', files: [] };
  let context;
  try {
    const [rows, events, certificates] = await Promise.all([evidenceModel.listBySubmission(submission.id),
      evidenceModel.listEventFacts(submission.id), evidenceModel.listCertificates()]);
    context = { rows, events, certificates, people: new Map() };
  } catch (_) { context = { rows: [], events: [], certificates: [], unavailable: true }; }
  const checked = [];
  for (const file of selected) {
    const stored = options.uploadedBytes ? { buffer: options.uploadedBytes } : readStoredAuditFile(file, { requireIntegrity: false });
    checked.push(await verifyFile(stored.buffer, file, context));
  }
  const overallStatus = combine(checked.map(item => ({ status: item.overallStatus })));
  return { verificationVersion: 2, verificationSource: options.uploadedBytes ? 'uploaded_file' : 'stored_file',
    overallStatus, valid: overallStatus === 'passed', files: checked };
}
async function verifyUnmatchedUpload(bytes) {
  // 没有平台记录并不妨碍验证上传字节，也不能仅凭外部签名推断历史身份。
  const file = await verifyFile(bytes, null, { unavailable: true });
  return { verificationVersion: 2, verificationSource: 'uploaded_file', overallStatus: file.overallStatus,
    verificationScope: 'file_only', valid: false, files: [file], matches: [], matchCount: 0, reasonCode: 'platform_record_not_matched' };
}
module.exports = { verifySubmissionFiles, verifyUnmatchedUpload, verifyFile, eventBindingsValid, combine };
