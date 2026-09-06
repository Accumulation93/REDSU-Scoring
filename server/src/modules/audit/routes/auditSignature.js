const localeCopy = require('../../../locales/zh-CN/generated/modules/audit/routes/auditSignature');
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../../utils/helpers');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const pool = require('../../../config/db');
const signatureTemplateModel = require('../models/signatureTemplate');
const submissionModel = require('../models/auditSubmission');
const verificationMatchModel = require('../models/auditVerificationMatch');
const verificationPermModel = require('../models/verificationPermission');
const unifiedIdentityModel = require('../../../core/models/unifiedIdentity');
const { resolveCurrentActor } = require('../../../core/services/currentActor');
const {
  resolveActorAssignment,
  resolveActorAssignmentForUpdate
} = require('../services/auditAssignmentContext');
const { MAX_FILE_SIZE } = require('../utils/fileSecurity');
const { verifySubmissionFiles, verifyUnmatchedUpload } = require('../services/signingVerification');
const signingCopy = require('../../../locales/zh-CN/auditSigningEvidence');
const { equalHex, decodeBase64 } = require('../utils/signingProtocol');
const { inspectAuditImageData } = require('../utils/auditImageData');

const MAX_SIGNATURE_NAME_CHARS = 100;

function validateSignatureTemplateInput(name, imageData) {
  if (Array.from(name).length > MAX_SIGNATURE_NAME_CHARS) {
    return { status: 'invalid_params', message: localeCopy.signatureNameTooLong };
  }
  const inspected = inspectAuditImageData(imageData);
  if (!inspected.ok) {
    return {
      status: 'invalid_params',
      message: inspected.reason === 'too_large'
        ? localeCopy.signatureImageTooLarge
        : localeCopy.signatureImageInvalid
    };
  }
  return null;
}

function decodeVerificationFile(fileBase64) {
  const encoded = safeString(fileBase64).replace(/[\r\n]/g, '');
  try { return encoded ? decodeBase64(encoded, MAX_FILE_SIZE) : null; }
  catch (_) { return null; }
}

async function resolveVerificationAccess(req) {
  const actorResult = await resolveCurrentActor(req);
  if (!actorResult.ok) return { canVerify: false, actorResult };
  if (actorResult.actor.type === 'admin') {
    return { canVerify: true, selectedRole: 'admin', hrId: null };
  }
  const orgId = await getCurrentOrgId();
  const assignment = await resolveActorAssignment(actorResult.actor, orgId);
  const hrId = assignment ? assignment.hr_id : null;
  const canVerify = Boolean(hrId) && await verificationPermModel.checkPermission(hrId);
  return { canVerify, selectedRole: 'user', hrId };
}

async function withLockedSignatureOwner(req, callback) {
  const actorResult = await resolveCurrentActor(req);
  if (!actorResult.ok || actorResult.actor.type !== 'user') return { forbidden: true };
  return pool.withTransaction(async (connection) => {
    const orgId = await getCurrentOrgId();
    await unifiedIdentityModel.lockActiveBusinessSubjects(connection, [{
      personId: safeString(actorResult.actor.personId),
      legacyHrId: safeString(actorResult.actor.id),
      organizationId: orgId,
      assignmentId: safeString(actorResult.actor.assignmentId)
    }]);
    const assignment = await resolveActorAssignmentForUpdate(actorResult.actor, orgId, connection);
    if (!assignment) return { forbidden: true };
    return callback(connection, { hrId: assignment.hr_id, orgId });
  });
}

function signatureOwnerForbidden(res) {
  return res.json({ status: 'forbidden', message: localeCopy.copy_162d055e98 });
}


// ═══════════════════════════════════════════════════
// Signature Template Management
// ═══════════════════════════════════════════════════

// listMySignatures
router.post('/listMySignatures', async (req, res) => {
  try {
    const actorResult = await resolveCurrentActor(req);
    if (!actorResult.ok || actorResult.actor.type !== 'user') {
      return res.json({ status: 'forbidden', message: localeCopy.copy_162d055e98 });
    }
    const assignment = await resolveActorAssignment(actorResult.actor, await getCurrentOrgId());
    if (!assignment) return res.json({ status: 'forbidden', message: localeCopy.copy_162d055e98 });
    const hrId = assignment.hr_id;

    const signatures = await signatureTemplateModel.getByHrId(hrId);
    const result = signatures.map((s) => ({
      id: safeString(s.id),
      name: safeString(s.name),
      imageData: s.image_data || '',
      isDefault: s.is_default === 1,
      createdAt: s.created_at
    }));

    res.json({ status: 'success', signatures: result });
  } catch (e) {
    console.error('[audit:signature:list] failed:', e);
    res.json({ status: 'error', message: localeCopy.signatureOperationFailed });
  }
});

// saveSignature
router.post('/saveSignature', async (req, res) => {
  try {
    const id = safeString(req.body.id);
    const name = safeString(req.body.name);
    const imageData = safeString(req.body.imageData);
    const isDefault = req.body.isDefault === true;

    if (!imageData) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_a35b383a47 });
    }
    const validationError = validateSignatureTemplateInput(name, imageData);
    if (validationError) return res.json(validationError);

    const result = await withLockedSignatureOwner(req, async (connection, owner) => {
      if (id) {
        const [rows] = await connection.query(
          'SELECT id, hr_id FROM signature_templates WHERE id = ? AND org_id = ? LIMIT 1 FOR UPDATE',
          [id, owner.orgId]
        );
        const existing = rows[0];
        if (!existing || safeString(existing.hr_id) !== owner.hrId) return { forbiddenSignature: true };
        if (isDefault) {
          await connection.query(
            'UPDATE signature_templates SET is_default = 0 WHERE hr_id = ? AND org_id = ?',
            [owner.hrId, owner.orgId]
          );
        }
        await connection.query(
          `UPDATE signature_templates
              SET name = ?, image_data = ?, is_default = ?
            WHERE id = ? AND hr_id = ? AND org_id = ?`,
          [name || '', imageData, isDefault ? 1 : 0, id, owner.hrId, owner.orgId]
        );
        return { status: 'success', message: localeCopy.copy_1c620d13e8 };
      }
      if (isDefault) {
        await connection.query(
          'UPDATE signature_templates SET is_default = 0 WHERE hr_id = ? AND org_id = ?',
          [owner.hrId, owner.orgId]
        );
      }
      const newId = generateId();
      await connection.query(
        `INSERT INTO signature_templates (id, hr_id, name, image_data, is_default, org_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId, owner.hrId, name || localeCopy.copy_214c901792, imageData, isDefault ? 1 : 0, owner.orgId]
      );
      return { status: 'success', id: newId, message: localeCopy.copy_082505816e };
    });
    if (result.forbidden) return signatureOwnerForbidden(res);
    if (result.forbiddenSignature) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_e6677fcefe });
    }
    return res.json(result);
  } catch (e) {
    console.error('[audit:signature:save] failed:', e);
    return res.json({ status: 'error', message: localeCopy.signatureOperationFailed });
  }
});

// deleteSignature
router.post('/deleteSignature', async (req, res) => {
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_6ae85136ce });
    const result = await withLockedSignatureOwner(req, async (connection, owner) => {
      const [rows] = await connection.query(
        'SELECT id, hr_id FROM signature_templates WHERE id = ? AND org_id = ? LIMIT 1 FOR UPDATE',
        [id, owner.orgId]
      );
      const existing = rows[0];
      if (!existing || safeString(existing.hr_id) !== owner.hrId) return { forbiddenSignature: true };
      await connection.query(
        'DELETE FROM signature_templates WHERE id = ? AND hr_id = ? AND org_id = ?',
        [id, owner.hrId, owner.orgId]
      );
      return { status: 'success', message: localeCopy.copy_1c47adeb46 };
    });
    if (result.forbidden) return signatureOwnerForbidden(res);
    if (result.forbiddenSignature) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_e6677fcefe });
    }
    return res.json(result);
  } catch (e) {
    console.error('[audit:signature:delete] failed:', e);
    return res.json({ status: 'error', message: localeCopy.signatureOperationFailed });
  }
});

// setDefaultSignature
router.post('/setDefaultSignature', async (req, res) => {
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_6ae85136ce });
    const result = await withLockedSignatureOwner(req, async (connection, owner) => {
      const [rows] = await connection.query(
        'SELECT id, hr_id FROM signature_templates WHERE id = ? AND org_id = ? LIMIT 1 FOR UPDATE',
        [id, owner.orgId]
      );
      const existing = rows[0];
      if (!existing || safeString(existing.hr_id) !== owner.hrId) return { forbiddenSignature: true };
      await connection.query(
        'UPDATE signature_templates SET is_default = 0 WHERE hr_id = ? AND org_id = ?',
        [owner.hrId, owner.orgId]
      );
      await connection.query(
        'UPDATE signature_templates SET is_default = 1 WHERE id = ? AND hr_id = ? AND org_id = ?',
        [id, owner.hrId, owner.orgId]
      );
      return { status: 'success', message: localeCopy.copy_ce2b164f35 };
    });
    if (result.forbidden) return signatureOwnerForbidden(res);
    if (result.forbiddenSignature) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_e6677fcefe });
    }
    return res.json(result);
  } catch (e) {
    console.error('[audit:signature:default] failed:', e);
    return res.json({ status: 'error', message: localeCopy.signatureOperationFailed });
  }
});

// ═══════════════════════════════════════════════════
// Chain Verification
// ═══════════════════════════════════════════════════

// getAuditVerificationAccess — 只返回当前组织下的验签权限。
router.post('/getAuditVerificationAccess', async (req, res) => {
  try {
    const access = await resolveVerificationAccess(req);
    return res.json({ status: 'success', canVerify: access.canVerify });
  } catch (e) {
    console.error('[audit:signature:access] failed:', e);
    return res.json({ status: 'error', message: localeCopy.verificationFailed });
  }
});

// verifySignatureChain — Verify hash chain of a submission
router.post('/verifySignatureChain', async (req, res) => {
  try {
    const submissionNumber = safeString(req.body.submissionNumber);
    const submissionId = safeString(req.body.submissionId);
    const fileHash = safeString(req.body.fileHash);
    const fileBase64 = safeString(req.body.fileBase64);

    const access = await resolveVerificationAccess(req);
    if (!access.canVerify) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_4ca1fc6fb1 });
    }

    if (fileHash && !/^[a-fA-F0-9]{64}$/.test(fileHash)) {
      return res.json({ status: 'invalid_params', message: localeCopy.verificationInputInvalid });
    }

    if (submissionId.length > 64 || submissionNumber.length > 64) {
      return res.json({ status: 'invalid_params', message: localeCopy.verificationInputInvalid });
    }
    let resolvedFileHash = fileHash.toLowerCase();
    let uploadedBytes = null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'fileBase64')) {
      uploadedBytes = decodeVerificationFile(fileBase64);
      if (!uploadedBytes) {
        return res.json({ status: 'invalid_params', message: localeCopy.verificationFileInvalid });
      }
      const actualHash = crypto.createHash('sha256').update(uploadedBytes).digest('hex');
      if (resolvedFileHash && !equalHex(resolvedFileHash, actualHash)) {
        return res.json({ status: 'invalid_params', message: signingCopy.inputMismatch });
      }
      resolvedFileHash = actualHash;
    }

    let submission;
    let matches = [];
    if (resolvedFileHash) {
      const matchRows = await verificationMatchModel.listFileHashMatches(resolvedFileHash);
      matches = verificationMatchModel.groupFileHashMatches(matchRows);
      if (!matches.length) {
        if (uploadedBytes) return res.json({ status: 'success', ...await verifyUnmatchedUpload(uploadedBytes) });
        return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
      }
      const selectedMatch = submissionId
        ? matches.find((item) => item.submissionId === submissionId)
        : matches[0];
      if (!selectedMatch) {
        return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
      }
      submission = await submissionModel.getById(selectedMatch.submissionId);
    } else if (submissionId) {
      submission = await submissionModel.getById(submissionId);
    } else if (submissionNumber) {
      submission = await submissionModel.getByNumber(submissionNumber);
    }

    if (!submission) {
      return res.json({ status: 'not_found', message: localeCopy.copy_780fb113f1 });
    }

    const result = await verifySubmissionFiles(submission, { uploadedBytes,
      source: uploadedBytes ? 'uploaded_file' : resolvedFileHash ? 'record_lookup' : 'stored_file' });

    res.json({
      status: 'success',
      submissionId: safeString(submission.id),
      submissionNumber: safeString(submission.submission_number),
      verifyByFileHash: resolvedFileHash || null,
      matchCount: matches.length,
      matches,
      ...result
    });
  } catch (e) {
    console.error('[audit:signature:verify] failed:', e);
    res.json({ status: 'error', message: localeCopy.verificationFailed });
  }
});

module.exports = router;
