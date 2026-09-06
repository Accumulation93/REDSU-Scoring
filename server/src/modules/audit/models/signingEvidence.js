'use strict';

const pool = require('../../../config/db');
const { generateId } = require('../../../utils/helpers');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const { fail, equalHex } = require('../utils/signingProtocol');

async function listByFile(fileId, round, connection) {
  const orgId = await getCurrentOrgId();
  const [rows] = await (connection || pool).query(
    'SELECT * FROM audit_signing_evidence WHERE org_id = ? AND file_id = ? AND round = ? ORDER BY step_index, id', [orgId, fileId, round]);
  return rows;
}
async function listBySubmission(submissionId, connection) {
  const orgId = await getCurrentOrgId();
  const [rows] = await (connection || pool).query(
    'SELECT * FROM audit_signing_evidence WHERE org_id = ? AND submission_id = ? ORDER BY round, step_index, file_id', [orgId, submissionId]);
  return rows;
}
async function getByRef(ref, connection) {
  const orgId = await getCurrentOrgId();
  const [rows] = await (connection || pool).query('SELECT * FROM audit_signing_evidence WHERE org_id = ? AND id = ?', [orgId, ref]);
  return rows[0] || null;
}
async function registerCertificate(key, connection) {
  const orgId = await getCurrentOrgId();
  await connection.query(`INSERT INTO audit_signing_certificates
    (id, org_id, key_version, certificate_fingerprint, certificate_pem, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?) ON DUPLICATE KEY UPDATE id = id`,
  [generateId(), orgId, key.version, key.fingerprint, key.identity.certificatePem, new Date()]);
  const [rows] = await connection.query('SELECT * FROM audit_signing_certificates WHERE org_id = ? AND key_version = ? FOR UPDATE', [orgId, key.version]);
  if (!rows[0] || rows[0].status !== 'active' || !equalHex(rows[0].certificate_fingerprint, key.fingerprint)) fail('evidence_certificate_unregistered');
}
async function listCertificates(connection) {
  const orgId = await getCurrentOrgId();
  const [rows] = await (connection || pool).query('SELECT * FROM audit_signing_certificates WHERE org_id = ?', [orgId]);
  return rows;
}
async function listEventFacts(submissionId, connection) {
  const orgId = await getCurrentOrgId();
  const [rows] = await (connection || pool).query(`SELECT e.id, e.org_id, e.submission_id,
      e.event_type, e.step_index, e.round, e.operator_person_id, e.operator_assignment_id,
      s.id AS step_id, s.processed_person_id, s.processed_assignment_id, s.status AS step_status
    FROM audit_events e
    JOIN audit_submission_steps s ON s.submission_id = e.submission_id AND s.org_id = e.org_id
      AND s.sort_order = e.step_index AND s.round = e.round
    WHERE e.org_id = ? AND e.submission_id = ? AND e.event_type IN ('approve', 'reject')
    ORDER BY e.round, e.step_index, e.id`, [orgId, submissionId]);
  return rows;
}
// 定时附件清理是全组织作业，只返回待检查路径交集，不返回人员或业务记录。
async function protectedPaths(candidates, connection) {
  if (!candidates.length) return [];
  const slots = candidates.map(() => '?').join(', ');
  const [rows] = await (connection || pool).query(`SELECT input_file_path, output_file_path FROM audit_signing_evidence
    WHERE input_file_path IN (${slots}) OR output_file_path IN (${slots})`, [...candidates, ...candidates]);
  return rows.flatMap(row => [row.input_file_path, row.output_file_path]);
}
async function create(receipt, context, connection) {
  const orgId = await getCurrentOrgId();
  if (orgId !== context.organizationId) fail('evidence_scope_mismatch');
  const p = receipt.payload;
  await connection.query(`INSERT INTO audit_signing_evidence
    (id, org_id, submission_id, step_id, step_index, round, event_id, file_id, person_id, assignment_id,
     action_type, key_version, certificate_fingerprint, identity_ciphertext, payload_json, cms_base64,
     receipt_digest, previous_digest, input_digest, output_digest, output_digest_type, final_file_digest,
     input_file_path, output_file_path, legacy_prefix, signed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [receipt.ref, orgId, context.submissionId, context.stepId, p.step, p.round, context.eventId, context.fileId,
    context.actor.person_id, context.actor.assignment_id, p.action, receipt.keyVersion, receipt.fingerprint,
    receipt.identityCiphertext, JSON.stringify(p), receipt.cms, receipt.receiptDigest, p.previous,
    p.inputDigest, p.outputDigest, p.outputDigestType, context.finalFileDigest,
    context.inputPath, context.outputPath, context.legacyPrefix ? 1 : 0, new Date(p.time)]);
}

module.exports = { listByFile, listBySubmission, getByRef, registerCertificate, listCertificates, listEventFacts, protectedPaths, create };
