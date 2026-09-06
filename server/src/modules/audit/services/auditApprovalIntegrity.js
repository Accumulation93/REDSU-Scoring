const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const stampAssignmentModel = require('../models/identityStampAssignment');
const {
  SIGNATURE_HASH_VERSION_V2,
  computeMaterialImageHash,
  computeSignatureHashV2
} = require('../utils/hashChain');
const { isValidAuditImageData } = require('../utils/auditImageData');

const MAX_APPROVAL_MATERIALS = 100;
const AUDIT_APPROVAL_INTEGRITY_CODES = Object.freeze({
  FINAL_PDF_UNAVAILABLE: 'approval_final_pdf_unavailable',
  MATERIAL_FILE_INVALID: 'approval_material_file_invalid'
});

class AuditApprovalIntegrityError extends Error {
  constructor(code) {
    super('Approval integrity check failed');
    this.name = 'AuditApprovalIntegrityError';
    this.code = code;
  }
}

function fail(code) {
  throw new AuditApprovalIntegrityError(code);
}

function normalizeApprovalActionType(value) {
  const actionType = String(value || '').trim().toLowerCase();
  if (actionType === 'estamp') return 'stamp';
  if (actionType === 'pass' || actionType === 'sign' || actionType === 'stamp' || actionType === 'both') {
    return actionType;
  }
  fail('approval_action_invalid');
}

function normalizeMaterialType(value) {
  const materialType = String(value || '').trim().toLowerCase();
  if (materialType === 'estamp') return 'stamp';
  if (materialType === 'signature' || materialType === 'stamp') return materialType;
  fail('approval_material_invalid');
}

function isValidImageData(value) {
  return isValidAuditImageData(value);
}

function normalizePlacement(raw, file) {
  const positionX = Number(raw.positionX);
  const positionY = Number(raw.positionY);
  const size = Number(raw.size);
  const rotation = Number(raw.rotation);
  const page = Number(raw.page);
  if (!Number.isFinite(positionX) || positionX < 0 || positionX > 1
    || !Number.isFinite(positionY) || positionY < 0 || positionY > 1
    || !Number.isFinite(size) || size < 0.5 || size > 2.2
    || !Number.isFinite(rotation) || rotation < -180 || rotation > 180
    || !Number.isInteger(page) || page < 1) {
    fail('approval_material_invalid');
  }
  const mimeType = String(file && file.mime_type || '').toLowerCase();
  if (mimeType.startsWith('image/') && page !== 1) fail('approval_material_invalid');
  if (mimeType === 'application/pdf') {
    const pageCount = Number(file && file.approval_page_count);
    if (!Number.isInteger(pageCount) || pageCount < 1 || page > pageCount) {
      fail('approval_material_invalid');
    }
  }
  return { positionX, positionY, size, rotation, page };
}

async function loadApprovalFileFacts(currentFiles, options, runtimeOverrides) {
  const files = Array.isArray(currentFiles) ? currentFiles : [];
  const config = options || {};
  if (config.requireAll === true && !files.length) fail(AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
  const materialFileIds = new Set((Array.isArray(config.materials) ? config.materials : [])
    .map((item) => String(item && item.fileId || '').trim()).filter(Boolean));
  const finalStep = config.finalStep === true;
  const runtime = Object.assign({
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    async getPdfPageCount(buffer) {
      const pdf = await PDFDocument.load(buffer, { updateMetadata: false });
      return pdf.getPageCount();
    }
  }, runtimeOverrides || {});
  const result = [];
  for (const sourceFile of files) {
    const file = Object.assign({}, sourceFile);
    const fileId = String(file.id || '');
    const mimeType = String(file.mime_type || '').toLowerCase();
    const requiredForMaterial = materialFileIds.has(fileId);
    const requiredForFinalPdf = finalStep && mimeType === 'application/pdf';
    if (!requiredForMaterial && !requiredForFinalPdf && config.requireAll !== true) {
      result.push(file);
      continue;
    }
    if (!file.file_path || !runtime.existsSync(file.file_path)) {
      fail(requiredForFinalPdf ? AUDIT_APPROVAL_INTEGRITY_CODES.FINAL_PDF_UNAVAILABLE : AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
    }
    let buffer;
    try {
      if (config.requireAll === true) {
        const stored = require('../utils/fileSecurity').readStoredAuditFile(file);
        if (stored.status !== 'success') fail(AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
        buffer = stored.buffer;
      } else {
        buffer = runtime.readFileSync(file.file_path);
      }
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        fail(requiredForFinalPdf ? AUDIT_APPROVAL_INTEGRITY_CODES.FINAL_PDF_UNAVAILABLE : AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
      }
      file.approval_source_buffer = buffer;
      if (mimeType === 'application/pdf') {
        file.approval_page_count = await runtime.getPdfPageCount(buffer);
        if (!Number.isInteger(file.approval_page_count) || file.approval_page_count < 1) {
          fail(requiredForFinalPdf ? AUDIT_APPROVAL_INTEGRITY_CODES.FINAL_PDF_UNAVAILABLE : AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
        }
      } else if (mimeType.startsWith('image/')) {
        file.approval_page_count = 1;
      }
    } catch (_) {
      fail(requiredForFinalPdf ? AUDIT_APPROVAL_INTEGRITY_CODES.FINAL_PDF_UNAVAILABLE : AUDIT_APPROVAL_INTEGRITY_CODES.MATERIAL_FILE_INVALID);
    }
    result.push(file);
  }
  return result;
}

function enforceMaterialRequirement(actionType, materialTypes) {
  const hasSignature = materialTypes.includes('signature');
  const hasStamp = materialTypes.includes('stamp');
  if (actionType === 'pass') {
    if (materialTypes.length) fail('approval_material_not_allowed');
    return;
  }
  if (actionType === 'sign') {
    if (!hasSignature) fail('approval_signature_required');
    if (hasStamp) fail('approval_material_not_allowed');
    return;
  }
  if (actionType === 'stamp') {
    if (!hasStamp) fail('approval_stamp_required');
    if (hasSignature) fail('approval_material_not_allowed');
    return;
  }
  if (!hasSignature && !hasStamp) fail('approval_both_required');
  if (!hasSignature) fail('approval_signature_required');
  if (!hasStamp) fail('approval_stamp_required');
}

async function resolveApprovalMaterials(options) {
  const opts = options || {};
  const actionType = normalizeApprovalActionType(opts.actionType);
  const rawMaterials = Array.isArray(opts.materials) ? opts.materials : [];
  if (rawMaterials.length > MAX_APPROVAL_MATERIALS) fail('approval_material_invalid');

  const materialTypes = rawMaterials.map((item) => normalizeMaterialType(item && item.signatureType));
  enforceMaterialRequirement(actionType, materialTypes);
  if (!rawMaterials.length) return [];

  const fileMap = new Map((Array.isArray(opts.currentFiles) ? opts.currentFiles : []).map((file) => [
    String(file && file.id || ''),
    file
  ]));
  const normalized = [];
  const requestedStampIds = new Set();

  for (let index = 0; index < rawMaterials.length; index += 1) {
    const raw = rawMaterials[index] || {};
    const signatureType = materialTypes[index];
    const fileId = String(raw.fileId || '').trim();
    if (!fileId || !fileMap.has(fileId)) fail('approval_material_file_invalid');
    const file = fileMap.get(fileId);
    const placement = normalizePlacement(raw, file);
    const material = {
      id: String(opts.generateId()),
      fileId,
      signatureType,
      imageData: '',
      stampId: '',
      stampName: '',
      ...placement
    };
    if (signatureType === 'signature') {
      const imageData = typeof raw.imageData === 'string' ? raw.imageData.trim() : '';
      if (!isValidImageData(imageData)) fail('approval_signature_invalid');
      material.imageData = imageData;
      material.materialImageHash = computeMaterialImageHash(imageData);
    } else {
      const stampId = String(raw.stampId || '').trim();
      if (!stampId) fail('approval_stamp_not_authorized');
      material.stampId = stampId;
      requestedStampIds.add(stampId);
    }
    normalized.push(material);
  }

  if (requestedStampIds.size) {
    const loadAuthorizedStamps = opts.loadAuthorizedStamps || (async (stampIds, identityId, db) => (
      stampAssignmentModel.getAuthorizedStampsForIdentityForUpdate(stampIds, identityId, db)
    ));
    const identityId = String(opts.approverAssignment && opts.approverAssignment.identity_id || '').trim();
    if (!identityId) fail('approval_stamp_not_authorized');
    const authorizedRows = await loadAuthorizedStamps([...requestedStampIds], identityId, opts.db);
    const authorizedMap = new Map((authorizedRows || []).map((row) => [String(row.id), row]));
    for (const stampId of requestedStampIds) {
      const row = authorizedMap.get(stampId);
      if (!row || !isValidImageData(row.image_data)) fail('approval_stamp_not_authorized');
    }
    normalized.forEach((material) => {
      if (material.signatureType !== 'stamp') return;
      const row = authorizedMap.get(material.stampId);
      material.imageData = row.image_data;
      material.stampName = String(row.name || '');
      material.materialImageHash = computeMaterialImageHash(row.image_data);
    });
  }

  return normalized;
}

function createDigitalSignatureMaterial(options) {
  const opts = options || {};
  const position = opts.signaturePosition || {};
  return {
    id: String(opts.generateId()),
    fileId: String(opts.fileId || ''),
    signatureType: 'digital',
    imageData: '',
    materialImageHash: '',
    stampId: '',
    positionX: Number.isFinite(Number(position.x)) ? Number(position.x) : 0.5,
    positionY: Number.isFinite(Number(position.y)) ? Number(position.y) : 0.5,
    size: 1,
    rotation: 0,
    page: Number.isInteger(Number(position.page)) && Number(position.page) > 0 ? Number(position.page) : 1
  };
}

function buildSignatureChainRecords(options) {
  const opts = options || {};
  const materials = Array.isArray(opts.materials) ? opts.materials : [];
  const signerSnapshot = opts.signerContextSnapshot || null;
  let previousHash = opts.previousSignatureHash || null;
  return materials.map((material) => {
    const signatureDataHash = computeSignatureHashV2({
      id: material.id,
      stepId: opts.stepId,
      signerHrId: opts.signerHrId,
      signatureType: material.signatureType,
      materialImageHash: material.materialImageHash || '',
      stampId: material.stampId || '',
      signerAssignmentId: opts.signerAssignmentId,
      signerContextSnapshot: signerSnapshot,
      positionX: material.positionX,
      positionY: material.positionY,
      size: material.size,
      rotation: material.rotation,
      page: material.page,
      round: opts.round,
      previousSignatureHash: previousHash,
      documentHash: opts.documentHash,
      signedAt: opts.signedAt
    });
    const record = {
      material,
      previousSignatureHash: previousHash,
      signatureDataHash,
      materialImageHash: material.materialImageHash || '',
      stampId: material.stampId || '',
      signerAssignmentId: opts.signerAssignmentId,
      signerContextSnapshot: signerSnapshot,
      hashVersion: SIGNATURE_HASH_VERSION_V2
    };
    previousHash = signatureDataHash;
    return record;
  });
}

function groupApprovalMaterialsByFile(materials) {
  const grouped = new Map();
  (Array.isArray(materials) ? materials : []).forEach((material) => {
    if (!grouped.has(material.fileId)) grouped.set(material.fileId, []);
    grouped.get(material.fileId).push(material);
  });
  return grouped;
}

function buildApprovalFileProcessingPlan(currentFiles, materialsByFile, finalStep) {
  const grouped = materialsByFile instanceof Map ? materialsByFile : new Map();
  return (Array.isArray(currentFiles) ? currentFiles : []).filter((file) => {
    const fileId = String(file && file.id || '');
    return grouped.has(fileId)
      || (finalStep === true && String(file && file.mime_type || '') === 'application/pdf');
  });
}


module.exports = {
  AUDIT_APPROVAL_INTEGRITY_CODES,
  AuditApprovalIntegrityError,
  normalizeApprovalActionType,
  isValidImageData,
  loadApprovalFileFacts,
  resolveApprovalMaterials,
  groupApprovalMaterialsByFile,
  buildApprovalFileProcessingPlan,
  createDigitalSignatureMaterial,
  buildSignatureChainRecords
};
