'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

process.env.DB_USER = process.env.DB_USER || 'contract-test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'contract-test';

const {
  AuditApprovalIntegrityError,
  resolveApprovalMaterials,
  groupApprovalMaterialsByFile,
  buildApprovalFileProcessingPlan,
  createDigitalSignatureMaterial,
  buildSignatureChainRecords
} = require('../src/modules/audit/services/auditApprovalIntegrity');
const {
  hashFile,
  verifySignatureChain
} = require('../src/modules/audit/utils/hashChain');
const {
  resolveActorAssignmentForUpdate
} = require('../src/modules/audit/services/auditAssignmentContext');
const { overlayOnPdfBuffer } = require('../src/modules/audit/utils/signatureOverlay');
const {
  generateSigningKeyPair,
  createSignerCertificate,
  signPdfBuffer,
  verifyPdfSignature,
  extractCmsDerFromPdfContents
} = require('../src/modules/audit/utils/pdfSignature');

const VALID_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X5W2GQAAAABJRU5ErkJggg==';
const currentFiles = [{ id: 'file-pdf', mime_type: 'application/pdf', approval_page_count: 1 }];
const approverAssignment = { identity_id: 'identity-a' };
let nextId = 0;

function material(signatureType, overrides) {
  return Object.assign({
    fileId: 'file-pdf',
    signatureType,
    imageData: VALID_PNG,
    stampId: 'stamp-a',
    positionX: 0.5,
    positionY: 0.4,
    size: 1,
    rotation: 0,
    page: 1
  }, overrides || {});
}

function resolve(actionType, materials, loadAuthorizedStamps) {
  return resolveApprovalMaterials({
    actionType,
    materials,
    currentFiles,
    approverAssignment,
    db: {},
    generateId() {
      nextId += 1;
      return 'material-' + nextId;
    },
    loadAuthorizedStamps: loadAuthorizedStamps || (async () => ([{
      id: 'stamp-a',
      name: '授权测试章',
      image_data: VALID_PNG
    }]))
  });
}

async function expectCode(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof AuditApprovalIntegrityError, message);
    assert.strictEqual(error.code, code, message);
    return true;
  });
}

(async () => {
  const terminalZeroDer = Buffer.from('3003040100', 'hex');
  const terminalZeroContents = Buffer.from('<3003040100000000>TAIL', 'ascii');
  assert.deepStrictEqual(
    extractCmsDerFromPdfContents(terminalZeroContents, [0, 0, 18, 4]),
    terminalZeroDer,
    'CMS 提取必须按 DER 声明长度保留签名末尾的合法 00 字节'
  );

  assert.deepStrictEqual(await resolve('pass', []), [], '纯通过步骤不应要求可见签署材料');
  await expectCode(
    resolve('pass', [material('signature')]),
    'approval_material_not_allowed',
    '纯通过步骤不得夹带签名材料'
  );
  await expectCode(resolve('sign', []), 'approval_signature_required', '签字步骤缺少手写签名必须拒绝');
  await expectCode(resolve('estamp', []), 'approval_stamp_required', '盖章步骤缺少授权印章必须拒绝');
  await expectCode(
    resolve('both', [material('stamp', { imageData: 'data:image/png;base64,Zm9yZ2Vk' })]),
    'approval_signature_required',
    '签字盖章步骤只有印章时必须拒绝'
  );
  await expectCode(
    resolve('both', [material('signature', { stampId: '' })]),
    'approval_stamp_required',
    '签字盖章步骤只有手写签名时必须拒绝'
  );
  await expectCode(
    resolve('sign', [material('signature', { positionX: undefined })]),
    'approval_material_invalid',
    '手写签名缺少定位字段必须拒绝'
  );
  await expectCode(
    resolve('sign', [material('signature', { imageData: 'not-an-image' })]),
    'approval_signature_invalid',
    '手写签名图像字段无效必须拒绝'
  );
  await expectCode(
    resolve('sign', [material('signature', { page: 2 })]),
    'approval_material_invalid',
    'PDF 页码超过实际页数必须拒绝'
  );
  await expectCode(
    resolveApprovalMaterials({
      actionType: 'sign',
      materials: [material('signature', { fileId: 'file-image', page: 2 })],
      currentFiles: [{ id: 'file-image', mime_type: 'image/png', approval_page_count: 1 }],
      approverAssignment,
      db: {},
      generateId: () => 'image-material'
    }),
    'approval_material_invalid',
    '图片签署页码只能为第一页'
  );
  await expectCode(
    resolve('estamp', [material('stamp')], async () => []),
    'approval_stamp_not_authorized',
    '伪造或未授权的 stampId 必须拒绝'
  );

  const forgedClientStamp = 'data:image/png;base64,Zm9yZ2Vk';
  const authorizedStamp = await resolve('estamp', [material('stamp', { imageData: forgedClientStamp })]);
  assert.strictEqual(authorizedStamp.length, 1);
  assert.strictEqual(authorizedStamp[0].stampId, 'stamp-a');
  assert.strictEqual(authorizedStamp[0].imageData, VALID_PNG, '印章合成必须使用数据库原图');
  assert.notStrictEqual(authorizedStamp[0].imageData, forgedClientStamp, '不得信任客户端印章图像');

  const both = await resolve('both', [material('signature'), material('stamp')]);
  const grouped = groupApprovalMaterialsByFile(both);
  assert.strictEqual(grouped.get('file-pdf').length, 2, '签名与印章应进入同一附件处理链');

  const files = [
    { id: 'final-pdf', mime_type: 'application/pdf' },
    { id: 'final-image', mime_type: 'image/png' }
  ];
  const finalPassPlan = buildApprovalFileProcessingPlan(files, new Map(), true);
  assert.deepStrictEqual(finalPassPlan.map((file) => file.id), ['final-pdf'],
    '最后一步纯通过时仍必须处理全部当前 PDF，且不得改写非 PDF');

  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const originalPdf = Buffer.from(await pdf.save());
  const keyPair = generateSigningKeyPair();
  // 此处继续覆盖历史哈希链；新版步骤凭证与事务由 signingEvidence 专项测试覆盖。
  const certificate = createSignerCertificate(keyPair.privateKey, keyPair.publicKey, '安全测试审批人', '', '审核安全测试组织');
  const signed = { buffer: await signPdfBuffer(originalPdf, keyPair.privateKeyPem, certificate) };
  const verification = verifyPdfSignature(signed.buffer);
  assert.strictEqual(verification.present, true, '最终 PDF 应包含 PKCS#7 签名');
  assert.strictEqual(
    verification.valid,
    true,
    `最终 PDF 的 PKCS#7 签名必须有效：${JSON.stringify(verification.signatures)}`
  );

  const finalDocumentHash = hashFile(signed.buffer);
  const signerSnapshot = {
    organizationId: 'org-a',
    personId: 'person-a',
    membershipId: 'membership-a',
    assignmentId: 'assignment-a',
    assignmentNature: 'internal',
    assignmentLabel: '主席团成员 · 主席团',
    departmentId: 'department-a',
    department: '主席团',
    identityCategoryId: 'identity-a',
    identityCategory: '主席团成员',
    workGroupId: '',
    workGroup: ''
  };
  const digitalMaterial = createDigitalSignatureMaterial({
    generateId: () => 'digital-final',
    fileId: 'final-pdf'
  });
  const purePassRecords = buildSignatureChainRecords({
    materials: [digitalMaterial],
    previousSignatureHash: null,
    stepId: 'step-final',
    signerHrId: 'hr-a',
    signerAssignmentId: 'assignment-a',
    signerContextSnapshot: signerSnapshot,
    round: 1,
    documentHash: finalDocumentHash,
    signedAt: '2026-08-30T12:00:00.000Z'
  });
  function asVerificationRow(record) {
    return {
      id: record.material.id,
      step_id: 'step-final',
      file_id: 'final-pdf',
      signer_hr_id: 'hr-a',
      signature_type: record.material.signatureType,
      image_data: record.material.imageData,
      material_image_hash: record.materialImageHash,
      stamp_id: record.stampId,
      signer_assignment_id: record.signerAssignmentId,
      signer_context_snapshot: record.signerContextSnapshot,
      position_x: record.material.positionX,
      position_y: record.material.positionY,
      signature_size: record.material.size,
      rotation_degrees: record.material.rotation,
      page: record.material.page,
      round: 1,
      previous_signature_hash: record.previousSignatureHash,
      document_hash_at_signing: finalDocumentHash,
      signature_data_hash: record.signatureDataHash,
      signed_at: '2026-08-30T12:00:00.000Z',
      hash_version: record.hashVersion
    };
  }
  const purePassRows = purePassRecords.map(asVerificationRow);
  const purePassChain = verifySignatureChain(purePassRows, { 'final-pdf': finalDocumentHash }, {
    requiredFileIds: ['final-pdf']
  });
  assert.strictEqual(purePassChain.valid, true, '最终纯通过必须由数字签名链节点绑定当前 PDF');
  const missingPurePassChain = verifySignatureChain([], { 'final-pdf': finalDocumentHash }, {
    requiredFileIds: ['final-pdf']
  });
  assert.strictEqual(missingPurePassChain.valid, false, '当前 PDF 没有链记录时不得返回 valid');
  const missingCurrentFile = verifySignatureChain(purePassRows, {}, {
    requiredFileIds: ['final-pdf']
  });
  assert.strictEqual(missingCurrentFile.valid, false, '必验 PDF 缺少当前文件哈希时核心验签必须失败关闭');
  assert.strictEqual(missingCurrentFile.files[0].currentFileMissing, true,
    '核心验签结果应明确标记当前文件缺失');

  const overlayPageOverflow = await overlayOnPdfBuffer(originalPdf, [{
    imageData: VALID_PNG,
    signatureType: 'signature',
    positionX: 0.5,
    positionY: 0.5,
    size: 1,
    rotation: 0,
    page: 2
  }]);
  assert.strictEqual(overlayPageOverflow, null,
    '共享 PDF 合成器不得把越界页码夹到最后一页');

  const visibleMaterial = (await resolve('sign', [material('signature', { stampId: '' })]))[0];
  visibleMaterial.id = 'visible-before-final';
  visibleMaterial.fileId = 'final-pdf';
  const visibleThenDigital = buildSignatureChainRecords({
    materials: [visibleMaterial, digitalMaterial],
    previousSignatureHash: null,
    stepId: 'step-final',
    signerHrId: 'hr-a',
    signerAssignmentId: 'assignment-a',
    signerContextSnapshot: signerSnapshot,
    round: 1,
    documentHash: finalDocumentHash,
    signedAt: '2026-08-30T12:00:00.000Z'
  }).map(asVerificationRow);
  assert.strictEqual(
    verifySignatureChain(visibleThenDigital, { 'final-pdf': finalDocumentHash }, { requiredFileIds: ['final-pdf'] }).valid,
    true,
    '前序可见签名后最终纯通过的数字节点必须延续同一条链'
  );
  const tamperedMaterial = visibleThenDigital.map((row) => Object.assign({}, row));
  tamperedMaterial[0].material_image_hash = '0'.repeat(64);
  assert.strictEqual(
    verifySignatureChain(tamperedMaterial, { 'final-pdf': finalDocumentHash }, { requiredFileIds: ['final-pdf'] }).valid,
    false,
    '材料图像摘要被篡改时 v2 链必须失效'
  );
  const tamperedSnapshot = visibleThenDigital.map((row) => Object.assign({}, row));
  tamperedSnapshot[0].signer_context_snapshot = Object.assign({}, signerSnapshot, { departmentId: 'other-department' });
  assert.strictEqual(
    verifySignatureChain(tamperedSnapshot, { 'final-pdf': finalDocumentHash }, { requiredFileIds: ['final-pdf'] }).valid,
    false,
    '岗位授权快照被篡改时 v2 链必须失效'
  );


  const assignmentQueries = [];
  const lockedAssignment = await resolveActorAssignmentForUpdate({
    type: 'user',
    id: 'hr-a',
    personId: 'person-a',
    assignmentId: 'assignment-a'
  }, 'org-a', {
    async query(sql, params) {
      assignmentQueries.push({ sql, params });
      return [[{
        assignment_id: 'assignment-a',
        membership_id: 'membership-a',
        org_id: 'org-a',
        assignment_kind: 'internal',
        department_id: 'department-new',
        identity_id: 'identity-new',
        work_group_id: 'group-new',
        person_id: 'person-a',
        hr_id: 'hr-a',
        name: '安全测试审批人',
        student_id: 'TEST-001',
        department_name: '新部门',
        identity_name: '新身份',
        work_group_name: '新职能组'
      }], []];
    }
  });
  assert.strictEqual(lockedAssignment.department_id, 'department-new', '授权必须使用事务内重读的完整岗位元组');
  assert(assignmentQueries[0].sql.includes('ma.org_id = ?') && assignmentQueries[0].sql.includes('FOR UPDATE'),
    '事务内岗位重读必须按组织隔离并加行锁');
  assert.deepStrictEqual(assignmentQueries[0].params, ['org-a', 'assignment-a']);

  const routeSource = fs.readFileSync(
    path.resolve(__dirname, '../src/modules/audit/routes/auditUser.js'),
    'utf8'
  );
  const approvalRoute = routeSource.slice(
    routeSource.indexOf("router.post('/approveStep'"),
    routeSource.indexOf("router.post('/rejectStep'")
  );
  assert(approvalRoute.includes('getCurrentBySubmissionIdForUpdate(submissionId, conn)')
    && approvalRoute.includes('resolveActorAssignmentForUpdate(actor, orgId, conn)')
    && approvalRoute.includes('resolveApprovalMaterials({')
    && approvalRoute.indexOf('resolveApprovalMaterials({') < approvalRoute.indexOf('updateStatus(stepId'),
  '审批材料必须在步骤状态写入前完成锁定与校验');
  assert(approvalRoute.includes('const filesToProcess = currentFiles;')
    && approvalRoute.includes('prepareEvidence({') && approvalRoute.includes('requireAll: true'),
  '每一步必须从全部当前附件生成凭证，不能依赖本次新增图层');

  const stampModelSource = fs.readFileSync(
    path.resolve(__dirname, '../src/modules/audit/models/identityStampAssignment.js'),
    'utf8'
  );
  assert(stampModelSource.includes('JOIN stamps s')
    && stampModelSource.includes('isa.identity_id = ?')
    && stampModelSource.includes('isa.org_id = ?')
    && stampModelSource.includes('FOR UPDATE'),
  '印章授权必须按当前身份与组织查询并在事务中锁定');

  const frontendSource = fs.readFileSync(
    path.resolve(__dirname, '../../miniprogram/subpackages/audit/pages/submissionDetail/submissionDetail.js'),
    'utf8'
  );
  assert(frontendSource.includes("material.stampId = s.stampId")
    && frontendSource.includes("material.imageData = s.imageData"),
  '前端必须按材料类型分别提交 stampId 或手写签名图像');
  assert(frontendSource.includes("return value === 'stamp' ? 'estamp'")
    && frontendSource.includes('(res.steps || []).map(normalizeApprovalStepForView)'),
  '历史 stamp 动作必须先规范化为前端统一使用的 estamp');
  const legacyApproval = frontendSource.slice(
    frontendSource.indexOf('async confirmApproval()'),
    frontendSource.indexOf('// ── Next-step person designation')
  );
  assert(!legacyApproval.includes("name: 'approveStep'")
    && legacyApproval.includes("approvalAction !== 'reject'"),
  '旧审批弹窗不得保留第二条可绕过安全材料校验的通过请求');

  console.log('审核材料、授权印章与最终 PDF 完整性回归测试通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
