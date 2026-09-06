const localeCopy = require('../../../locales/zh-CN/generated/modules/audit/utils/fileSecurity');
const securityCopy = require('../../../locales/zh-CN/core/security');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../../../config/db');
const { safeString, generateId } = require('../../../utils/helpers');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const verificationPermModel = require('../models/verificationPermission');
const submissionFileModel = require('../models/auditSubmissionFile');
const submissionStepModel = require('../models/auditSubmissionStep');
const { resolveCurrentActor } = require('../../../core/services/currentActor');
const { hasAnyPermission } = require('../../../core/services/adminPermissions');
const auditTempUploadModel = require('../../../core/models/auditTempUpload');
const { resolveActorAssignment } = require('../services/auditAssignmentContext');
const {
  assignmentSqlExpression,
  submissionMatchesSubmitterAssignment
} = require('../services/auditHistoryScope');
const { JWT_SECRET } = require('../../../middleware/auth');
const { hashFile } = require('./hashChain');

const UPLOAD_DIR = path.resolve(
  process.env.AUDIT_UPLOAD_DIR || path.resolve(__dirname, '../../../../uploads/audit')
);
const TMP_DIR = path.join(UPLOAD_DIR, '_tmp');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_FILES_PER_SUBMISSION = 20;
const MAX_FILE_NAME_CHARS = 500;

function ensurePrivateDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(directoryPath, 0o700);
}

function ensurePrivateFile(filePath) {
  fs.chmodSync(filePath, 0o600);
}

function resolveStoredAuditFilePath(file) {
  const storedPath = safeString(file && file.file_path);
  if (!storedPath) return null;
  const resolvedPath = path.resolve(storedPath);
  const rootPrefix = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : UPLOAD_DIR + path.sep;
  if (resolvedPath === UPLOAD_DIR || !resolvedPath.startsWith(rootPrefix)) return null;
  return resolvedPath;
}

function isPathInsideUploadRoot(filePath) {
  const realRoot = fs.realpathSync(UPLOAD_DIR);
  const realFilePath = fs.realpathSync(filePath);
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realFilePath !== realRoot && realFilePath.startsWith(rootPrefix)
    ? realFilePath
    : null;
}

function readStoredAuditFile(file, options) {
  const settings = options || {};
  const candidatePath = resolveStoredAuditFilePath(file);
  if (!candidatePath || !fs.existsSync(candidatePath)) {
    return { status: 'not_found', message: localeCopy.storedFileUnavailable };
  }
  let filePath;
  try {
    filePath = isPathInsideUploadRoot(candidatePath);
  } catch (_) {
    filePath = null;
  }
  if (!filePath) return { status: 'not_found', message: localeCopy.storedFileUnavailable };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { status: 'not_found', message: localeCopy.storedFileUnavailable };
  }
  const buffer = fs.readFileSync(filePath);
  const actualHash = hashFile(buffer);
  const expectedSize = Number(file && file.file_size);
  const expectedHash = safeString(file && file.file_hash).toLowerCase();
  const integrityVerified = Number.isFinite(expectedSize)
    && expectedSize >= 0
    && expectedSize === buffer.length
    && /^[a-f0-9]{64}$/.test(expectedHash)
    && expectedHash === actualHash;
  if (settings.requireIntegrity !== false && !integrityVerified) {
    return { status: 'integrity_error', message: localeCopy.storedFileIntegrityMismatch };
  }
  return { status: 'success', filePath, buffer, actualHash, integrityVerified };
}

function normalizeUploadFileName(fileName, mimeType) {
  const fallback = 'audit-file' + extForMime(mimeType);
  const normalized = safeString(fileName).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || fallback;
  if (Array.from(normalized).length > MAX_FILE_NAME_CHARS) {
    const error = new Error(localeCopy.uploadFileNameTooLong);
    error.status = 'invalid_params';
    throw error;
  }
  return normalized;
}

function normalizeMime(mimeType) {
  const mime = safeString(mimeType).toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'application/x-pdf') return 'application/pdf';
  if (mime === 'application/octet-stream' || mime === 'binary/octet-stream') return '';
  return mime;
}

function detectMime(buffer) {
  if (!buffer || buffer.length < 4) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 &&
      buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  return '';
}

function extForMime(mimeType) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'application/pdf') return '.pdf';
  return '';
}

function assertAllowedFile(buffer, declaredMime) {
  const detectedMime = detectMime(buffer);
  const declaredType = normalizeMime(declaredMime);
  if (!detectedMime || !ALLOWED_MIMES.includes(detectedMime)) {
    const err = new Error(localeCopy.copy_1e8b224ee3);
    err.status = 'invalid_params';
    throw err;
  }
  if (declaredType && ALLOWED_MIMES.includes(declaredType) && declaredType !== detectedMime) {
    const err = new Error(localeCopy.copy_1e8b224ee3);
    err.status = 'invalid_params';
    throw err;
  }
  if (buffer.length > MAX_FILE_SIZE) {
    const err = new Error(localeCopy.copy_9288d54fa0);
    err.status = 'invalid_params';
    throw err;
  }
  return detectedMime;
}

function signUploadToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyUploadToken(token) {
  const parts = safeString(token).split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(parts[0]).digest('base64url');
  if (parts[1].length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function uploadOwnerHash(accountId) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update('audit-upload-owner:' + safeString(accountId))
    .digest('hex');
}

function resolveUploadOwnerHash(accountId) {
  // 账号只能由路由从认证中间件取得；微信绑定不是附件所有权或配额来源。
  const normalizedAccountId = safeString(accountId);
  if (!normalizedAccountId) {
    throw uploadQuotaError({ code: securityCopy.codes.uploadQuotaUnavailable });
  }
  return uploadOwnerHash(normalizedAccountId);
}

async function removeExpiredTempFiles(rows) {
  const candidates = (rows || []).map((row) => {
    const tempName = path.basename(safeString(row && row.temp_name));
    if (!tempName || tempName !== safeString(row && row.temp_name)) return null;
    return path.join(TMP_DIR, tempName);
  }).filter(Boolean);
  if (!candidates.length) return;
  const [referencedRows] = await pool.query(
    `SELECT file_path
       FROM audit_submission_files
      WHERE file_path IN (${candidates.map(() => '?').join(', ')})`,
    candidates
  );
  const referenced = new Set(referencedRows.map((row) => path.resolve(safeString(row.file_path))));
  const evidencePaths = await require('../models/signingEvidence').protectedPaths(candidates);
  evidencePaths.forEach(filePath => referenced.add(path.resolve(filePath)));
  candidates.forEach((candidate) => {
    if (referenced.has(path.resolve(candidate))) return;
    try { fs.unlinkSync(candidate); } catch (_) { /* 文件可能已由维护任务清理 */ }
  });
}

function uploadQuotaError(error) {
  const code = safeString(error && (error.code || error.status));
  const mapped = new Error(
    code === securityCopy.codes.uploadAccountQuotaExceeded ? securityCopy.uploadAccountQuotaExceeded
      : code === securityCopy.codes.uploadGlobalQuotaExceeded ? securityCopy.uploadGlobalQuotaExceeded
        : code === securityCopy.codes.uploadQuotaBusy ? securityCopy.uploadQuotaBusy
          : securityCopy.uploadQuotaUnavailable
  );
  mapped.status = code || securityCopy.codes.uploadQuotaUnavailable;
  return mapped;
}

async function createTempUpload({ buffer, fileName, mimeType, accountId }) {
  const orgId = await getCurrentOrgId();
  const ownerHash = resolveUploadOwnerHash(accountId);
  ensurePrivateDirectory(UPLOAD_DIR);
  ensurePrivateDirectory(TMP_DIR);

  const actualMime = assertAllowedFile(buffer, mimeType);
  const fileId = generateId();
  const cleanName = normalizeUploadFileName(fileName, actualMime);
  const ext = extForMime(actualMime);
  const tempName = fileId + ext;
  const tmpPath = path.join(TMP_DIR, tempName);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  let reserved = false;
  try {
    const reservation = await auditTempUploadModel.reserve({
      fileId,
      ownerHash,
      orgId,
      tempName,
      fileSize: buffer.length,
      expiresAt
    });
    reserved = true;
    await removeExpiredTempFiles(reservation.expiredRows);
    fs.writeFileSync(tmpPath, buffer, { flag: 'wx', mode: 0o600 });
    ensurePrivateFile(tmpPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* 未创建文件时忽略 */ }
    if (reserved) {
      try { await auditTempUploadModel.remove(fileId); } catch (_) { /* 配额记录会按 expires_at 自动清理 */ }
    }
    if (error && safeString(error.code || error.status).startsWith('upload_')) throw uploadQuotaError(error);
    throw uploadQuotaError({ code: securityCopy.codes.uploadQuotaUnavailable });
  }

  const fileHash = hashFile(buffer);
  const token = signUploadToken({
    fileId,
    fileName: cleanName,
    mimeType: actualMime,
    fileSize: buffer.length,
    fileHash,
    tempName,
    ownerHash,
    orgId,
    exp: expiresAt.getTime()
  });

  return { fileId, fileName: cleanName, mimeType: actualMime, fileSize: buffer.length, fileHash, fileToken: token };
}

async function resolveUploadedFile(uploadedFile, accountId) {
  const orgId = await getCurrentOrgId();
  const ownerHash = resolveUploadOwnerHash(accountId);
  const tokenPayload = verifyUploadToken(uploadedFile.fileToken);
  const meta = tokenPayload;
  if (!meta) {
    const err = new Error(localeCopy.copy_03d69a9d28);
    err.status = 'invalid_params';
    throw err;
  }

  if (!safeString(meta.ownerHash) || safeString(meta.ownerHash) !== ownerHash) {
    const err = new Error(localeCopy.copy_8753bfeb5f);
    err.status = 'forbidden';
    throw err;
  }
  if (!safeString(meta.orgId) || safeString(meta.orgId) !== orgId) {
    const err = new Error(localeCopy.copy_a5b624ccc1);
    err.status = 'forbidden';
    throw err;
  }
  const tempName = path.basename(safeString(meta.tempName));
  if (!tempName || tempName !== safeString(meta.tempName)) {
    const err = new Error(localeCopy.copy_03d69a9d28);
    err.status = 'invalid_params';
    throw err;
  }
  let quotaRecord;
  try {
    quotaRecord = await auditTempUploadModel.findActive(safeString(meta.fileId), ownerHash, orgId);
  } catch (_) {
    throw uploadQuotaError({ code: securityCopy.codes.uploadQuotaUnavailable });
  }
  if (!quotaRecord || safeString(quotaRecord.temp_name) !== tempName) {
    const err = new Error(localeCopy.copy_03d69a9d28);
    err.status = 'not_found';
    throw err;
  }
  const tmpPath = path.join(TMP_DIR, tempName);
  if (!fs.existsSync(tmpPath)) {
    const err = new Error(localeCopy.copy_03d69a9d28);
    err.status = 'not_found';
    throw err;
  }

  const buffer = fs.readFileSync(tmpPath);
  const actualMime = assertAllowedFile(buffer, meta.mimeType);
  const actualHash = hashFile(buffer);
  if (Number(meta.fileSize) !== buffer.length || safeString(meta.fileHash) !== actualHash) {
    const err = new Error(localeCopy.uploadedFileIntegrityMismatch);
    err.status = 'invalid_params';
    throw err;
  }
  return {
    fileId: safeString(meta.fileId) || generateId(),
    fileName: normalizeUploadFileName(meta.fileName, actualMime),
    mimeType: actualMime,
    fileSize: buffer.length,
    fileHash: actualHash,
    tmpPath
  };
}

async function attachUploadedFiles({ uploadedFiles, submissionId, accountId, conn, sortOrderOffset }) {
  if (!Array.isArray(uploadedFiles) || uploadedFiles.length > MAX_FILES_PER_SUBMISSION) {
    const err = new Error(localeCopy.copy_a0736fb41c);
    err.status = 'invalid_params';
    throw err;
  }
  if (!conn || typeof conn.query !== 'function') {
    const error = new Error(localeCopy.uploadTransactionUnavailable);
    error.status = 'error';
    throw error;
  }
  const normalizedSubmissionId = safeString(submissionId);
  if (!normalizedSubmissionId || path.basename(normalizedSubmissionId) !== normalizedSubmissionId) {
    const error = new Error(localeCopy.copy_03d69a9d28);
    error.status = 'invalid_params';
    throw error;
  }
  ensurePrivateDirectory(UPLOAD_DIR);
  const submissionDir = path.join(UPLOAD_DIR, normalizedSubmissionId);
  ensurePrivateDirectory(submissionDir);
  const movedFiles = [];

  try {
    for (let i = 0; i < uploadedFiles.length; i++) {
      const meta = await resolveUploadedFile(uploadedFiles[i], accountId);
      const ext = extForMime(meta.mimeType);
      const destPath = path.join(submissionDir, meta.fileId + ext);
      if (fs.existsSync(destPath)) {
        const error = new Error(localeCopy.uploadedFileIntegrityMismatch);
        error.status = 'invalid_params';
        throw error;
      }
      fs.renameSync(meta.tmpPath, destPath);
      ensurePrivateFile(destPath);
      movedFiles.push({ sourcePath: meta.tmpPath, destinationPath: destPath });
      await submissionFileModel.create(meta.fileId, {
        submissionId: normalizedSubmissionId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        filePath: destPath,
        fileSize: meta.fileSize,
        fileHash: meta.fileHash,
        sortOrder: Math.max(0, Number(sortOrderOffset) || 0) + i + 1
      }, conn);
      await auditTempUploadModel.remove(meta.fileId, conn);
    }
  } catch (error) {
    for (let index = movedFiles.length - 1; index >= 0; index -= 1) {
      const moved = movedFiles[index];
      try {
        if (fs.existsSync(moved.destinationPath) && !fs.existsSync(moved.sourcePath)) {
          fs.renameSync(moved.destinationPath, moved.sourcePath);
          ensurePrivateFile(moved.sourcePath);
        }
      } catch (_) {
        // 无法立即复原时保留文件，由带宽限期且逐文件复核数据库引用的维护任务接管。
      }
    }
    try {
      if (fs.existsSync(submissionDir) && fs.readdirSync(submissionDir).length === 0) fs.rmdirSync(submissionDir);
    } catch (_) { /* 目录仍被使用时保留 */ }
    throw error;
  }
}

async function getAuthorizedAuditFile(fileId, req) {
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query(
    `SELECT f.*, s.submitted_by, s.submitted_assignment_id, s.submitted_context_snapshot
     FROM audit_submission_files f
     JOIN audit_submissions s ON s.id = f.submission_id AND s.org_id = f.org_id
     WHERE f.id = ? AND f.org_id = ?`,
    [fileId, orgId]
  );
  const file = rows[0];
  if (!file) return { status: 'not_found', message: localeCopy.copy_03d69a9d28 };

  const actorResult = await resolveCurrentActor(req);
  if (!actorResult.ok) return { status: 'forbidden', message: localeCopy.copy_162d055e98 };
  if (actorResult.actor.type === 'admin') {
    if (!hasAnyPermission(req.adminPermissions, ['audit.submissions'])) {
      return { status: 'forbidden', message: localeCopy.copy_f1cdbd7be3 };
    }
    return { status: 'success', file };
  }

  const actor = actorResult.actor;
  const assignment = await resolveActorAssignment(actor, orgId);
  if (!assignment) return { status: 'forbidden', message: localeCopy.copy_162d055e98 };
  const hrId = assignment.hr_id;
  if (file.submitted_by === hrId && submissionMatchesSubmitterAssignment(
    file,
    assignment.assignment_id
  )) return { status: 'success', file };

  const pendingSteps = await submissionStepModel.getPendingByApprover(actor, assignment);
  if (pendingSteps.some(function(step) { return step.submission_id === file.submission_id; })) {
    return { status: 'success', file };
  }

  const handledAssignmentSql = assignmentSqlExpression('e', 'handled_step');
  const [eventRows] = await pool.query(
    `SELECT e.id FROM audit_events e
      LEFT JOIN audit_submission_steps handled_step
        ON handled_step.submission_id = e.submission_id
       AND handled_step.sort_order = e.step_index
       AND handled_step.round = e.round
       AND handled_step.org_id = e.org_id
      WHERE e.submission_id = ? AND e.org_id = ?
        AND e.event_type IN ('approve', 'reject')
        AND ${handledAssignmentSql} = ?
      LIMIT 1`,
    [file.submission_id, orgId, assignment.assignment_id]
  );
  if (eventRows.length) return { status: 'success', file };

  if (await verificationPermModel.checkPermission(hrId)) return { status: 'success', file };
  return { status: 'forbidden', message: localeCopy.copy_f1cdbd7be3 };
}

module.exports = {
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  ALLOWED_MIMES,
  MAX_FILE_NAME_CHARS,
  assertAllowedFile,
  normalizeUploadFileName,
  ensurePrivateDirectory,
  ensurePrivateFile,
  resolveStoredAuditFilePath,
  readStoredAuditFile,
  uploadOwnerHash,
  resolveUploadOwnerHash,
  createTempUpload,
  attachUploadedFiles,
  getAuthorizedAuditFile
};
