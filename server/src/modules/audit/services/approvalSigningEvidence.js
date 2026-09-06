'use strict';

const model = require('../models/signingEvidence');
const { loadKeyring } = require('./signingEvidenceKeys');
const { createReceipt, buildManifest, verifyManifest } = require('./signingEvidenceProtocol');
const { canonicalBytes, sha256, equalHex, fail, MAX_RECEIPTS } = require('../utils/signingProtocol');
const { signPdfBuffer } = require('../utils/pdfSignedDocument');

async function prepareEvidence(context) {
  const keyring = loadKeyring();
  await model.registerCertificate(keyring.active, context.db);
  const documentIdentity = keyring.active.documentIdentity || keyring.active.identity;
  if (context.finalPdf && keyring.active.documentFingerprint !== keyring.active.fingerprint) {
    await model.registerCertificate({ version: 'doc-' + keyring.active.documentFingerprint.slice(0, 24),
      fingerprint: keyring.active.documentFingerprint, identity: documentIdentity }, context.db);
  }
  const prior = await model.listByFile(context.fileId, context.round, context.db);
  if (prior.length >= MAX_RECEIPTS) fail('evidence_manifest_too_large');
  if (prior.length) {
    const checked = verifyManifest({ version: 2, legacyPrefix: Boolean(prior[0].legacy_prefix),
      receipts: prior.map(row => row.cms_base64) }, prior, keyring);
    if (!checked.ok) fail(checked.reasonCode);
  }
  const last = prior[prior.length - 1];
  const legacyPrefix = prior.length ? Boolean(prior[0].legacy_prefix) : context.step !== 1;
  if (last && Number(last.step_index) !== context.step - 1) fail('evidence_chain_incomplete');
  if (last && !equalHex(last.final_file_digest, context.inputDigest)) fail('evidence_document_chain_invalid');
  const options = { ...context, previous: last ? last.receipt_digest : '',
    materialsDigest: sha256(canonicalBytes(context.materials || [])) };
  let receipt;
  let buffer = context.buffer;
  if (context.finalPdf) {
    buffer = await signPdfBuffer(context.buffer, documentIdentity.privateKeyPem,
      documentIdentity.certificatePem, { signer: { name: context.actor.name },
        signatureCapacity: Math.min(2 * 1024 * 1024, prior.reduce((sum, row) => sum + Buffer.byteLength(row.cms_base64) + 4, 65536)
          + Buffer.byteLength(keyring.active.identity.certificateChainPem || '') * 2
          + Buffer.byteLength(documentIdentity.certificateChainPem || '')),
        certificateChainPem: documentIdentity.certificateChainPem,
        signaturePosition: context.signaturePosition,
        createManifest(bytes) {
          receipt = createReceipt({ ...options, outputDigest: sha256(bytes), outputDigestType: 'pdf_byte_range_sha256' }, keyring);
          return buildManifest(prior, receipt, legacyPrefix);
        } });
  } else {
    receipt = createReceipt({ ...options, outputDigest: sha256(buffer), outputDigestType: 'file_sha256' }, keyring);
  }
  return { buffer, receipt, context: { ...context, legacyPrefix, finalFileDigest: sha256(buffer) } };
}

module.exports = { prepareEvidence };
