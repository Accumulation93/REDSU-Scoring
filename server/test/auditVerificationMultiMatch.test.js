'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SAME_FILE_HASH = crypto.createHash('sha256').update(Buffer.from('same-file')).digest('hex');

process.env.JWT_SECRET = 'audit-verification-test-secret';
process.env.AUTH_IDENTITY_SECRET = 'audit-verification-identity-test-secret-32-bytes';

const matchRows = [
  {
    file_id: 'file-new-a',
    submission_id: 'submission-new',
    file_name: 'same.pdf',
    file_size: 120,
    submission_number: 'SUB-NEW',
    title: 'New submission',
    status: 'approved'
  },
  {
    file_id: 'file-new-b',
    submission_id: 'submission-new',
    file_name: 'same-copy.pdf',
    file_size: 120,
    submission_number: 'SUB-NEW',
    title: 'New submission',
    status: 'approved'
  },
  {
    file_id: 'file-old',
    submission_id: 'submission-old',
    file_name: 'same.pdf',
    file_size: 120,
    submission_number: 'SUB-OLD',
    title: 'Old submission',
    status: 'rejected'
  }
];

let verificationQuery = null;
let verificationAllowed = true;
let noMatchingRecord = false;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../../../config/db') {
    return {
      async query(sql, params) {
        if (sql.includes('FROM user_info')) return [[{ hr_id: 'hr-verifier' }]];
        if (sql.includes('FROM audit_submission_files asf')) {
          verificationQuery = { sql, params };
          return [noMatchingRecord ? [] : matchRows];
        }
        throw new Error('Unexpected SQL in audit verification test: ' + sql);
      }
    };
  }
  if (request === '../../../utils/orgContext') return { async getCurrentOrgId() { return 'org-current'; } };
  if (request === '../../../core/models/userInfo') return {};
  if (request === '../../../core/models/hrInfo') return {};
  if (request === '../models/signatureTemplate') return {};
  if (request === '../models/auditSubmission') {
    return {
      async getById(id) {
        const row = matchRows.find((item) => item.submission_id === id);
        return row ? { id, submission_number: row.submission_number } : null;
      },
      async getByNumber() { return null; }
    };
  }
  if (request === '../models/auditSubmissionFile') return { async getBySubmissionId() { return []; } };
  if (request === '../models/auditSubmissionSignature') return { async getChainForVerification() { return []; } };
  if (request === '../models/verificationPermission') return { async checkPermission() { return verificationAllowed; } };
  if (request === '../utils/fileSecurity') {
    return {
      MAX_FILE_SIZE: 20 * 1024 * 1024,
      async readStoredAuditFile() { return Buffer.alloc(0); }
    };
  }
  if (request === '../../../core/models/adminInfo') return { async getByOpenid() { return null; } };
  if (request === '../../../core/models/unifiedIdentity') return {};
  if (request === '../../../core/services/currentActor') {
    return {
      async resolveCurrentActor() {
        return {
          ok: true,
          actor: {
            type: 'user',
            id: 'hr-verifier',
            personId: 'person-verifier',
            assignmentId: 'assignment-verifier'
          }
        };
      }
    };
  }
  if (request === '../services/auditAssignmentContext') {
    return {
      async resolveActorAssignment() {
        return { hr_id: 'hr-verifier', assignment_id: 'assignment-verifier' };
      },
      async resolveActorAssignmentForUpdate() {
        return { hr_id: 'hr-verifier', assignment_id: 'assignment-verifier' };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const verificationMatchModel = require('../src/modules/audit/models/auditVerificationMatch');
const router = require('../src/modules/audit/routes/auditSignature');
Module._load = originalLoad;
const { presentVerificationResponse } = require('../../miniprogram/utils/auditVerification');

function findRoute(routePath) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert(layer, 'Missing route ' + routePath);
  return layer.route.stack[0].handle;
}

async function invokeVerification(body) {
  let response = null;
  await findRoute('/verifySignatureChain')({
    body,
    openid: 'openid-verifier',
    get(name) { return name === 'X-Role' ? 'user' : ''; }
  }, {
    json(payload) {
      response = payload;
      return payload;
    }
  });
  return response;
}

async function invokeVerificationAccess() {
  let response = null;
  await findRoute('/getAuditVerificationAccess')({
    body: {},
    openid: 'openid-verifier',
    authContext: { role: 'user', organizationId: 'org-current' },
    get() { return ''; }
  }, {
    json(payload) {
      response = payload;
      return payload;
    }
  });
  return response;
}

async function verifyUploadsOverHttp() {
  const express = require('express');
  const forge = require('node-forge');
  const { PDFDocument } = require('pdf-lib');
  const { createSignerCertificate } = require('../src/modules/audit/utils/pdfSignature');
  const { signPdfBuffer } = require('../src/modules/audit/utils/pdfSignedDocument');
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const certificate = createSignerCertificate(forge.pki.privateKeyFromPem(pair.privateKey),
    forge.pki.publicKeyFromPem(pair.publicKey), 'HTTP TEST', '', 'TEST');
  const pdf = await PDFDocument.create(); pdf.addPage();
  const unsigned = Buffer.from(await pdf.save());
  const signed = await signPdfBuffer(unsigned, pair.privateKey, certificate);
  const app = express();
  app.use(express.json({ limit: '14mb' }));
  app.use('/api', router);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  noMatchingRecord = true;
  try {
    const upload = async bytes => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/verifySignatureChain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64: bytes.toString('base64') })
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, 'success', '上传不能因无平台记录被挡在验签前');
      assert.equal(result.verificationSource, 'uploaded_file');
      assert.equal(result.verificationScope, 'file_only');
      assert.equal(result.valid, false, '文件签名有效不能冒充平台身份全部核实');
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].steps.length, 0);
      assert.equal(result.files[0].currentHash, crypto.createHash('sha256').update(bytes).digest('hex'));
      return result;
    };
    const normal = await upload(signed);
    assert.equal(normal.files[0].checks.cmsSignature.status, 'passed');
    assert.equal(normal.files[0].checks.documentIntegrity.status, 'passed');
    assert.equal(normal.files[0].checks.identityBinding.status, 'indeterminate');
    assert.equal(normal.overallStatus, 'indeterminate');
    const changed = await upload(Buffer.concat([signed, Buffer.from('\n% added')]));
    assert.equal(changed.overallStatus, 'failed');
    assert.equal(changed.files[0].checks.documentIntegrity.status, 'failed');
    const plain = await upload(unsigned);
    assert.equal(plain.files[0].checks.cmsSignature.reasonCode, 'pdf_unsigned');
    assert.equal(plain.overallStatus, 'indeterminate');
    console.log('真实 HTTP 上传验签通过：正常签名、签后篡改、未签名文件均不依赖申请记录');
  } finally {
    noMatchingRecord = false;
    await new Promise(resolve => server.close(resolve));
  }
}

function loadRetiredAdminRouter() {
  let dependencyCalls = 0;
  const failOnCall = function() {
    dependencyCalls += 1;
    throw new Error('退役端点不应访问业务依赖');
  };
  const failDependency = new Proxy({}, { get() { return failOnCall; } });
  const mocks = {
    '../../../utils/helpers': failDependency,
    '../../../utils/orgContext': failDependency,
    '../../../config/db': failDependency,
    '../../../core/models/adminInfo': failDependency,
    '../../../core/models/hrInfo': failDependency,
    '../models/auditFlowTemplate': failDependency,
    '../models/auditFlowTemplateStep': failDependency,
    '../models/auditFlowTemplateStepCondition': failDependency,
    '../models/stamp': failDependency,
    '../models/identityStampAssignment': failDependency,
    '../models/auditSubmission': failDependency,
    '../models/auditSubmissionStep': failDependency,
    '../models/auditSubmissionFile': failDependency,
    '../models/auditSubmissionSignature': failDependency,
    '../models/auditEvent': failDependency,
    '../models/verificationPermission': failDependency,
    '../services/auditPersonAssignmentCondition': failDependency,
    '../services/auditWorkflowPolicy': failDependency,
    '../../../core/services/dictionaryUsage': failDependency
  };
  const modulePath = require.resolve('../src/modules/audit/routes/auditAdmin');
  delete require.cache[modulePath];
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return load.call(this, request, parent, isMain);
  };
  try {
    return {
      router: require(modulePath),
      getDependencyCalls() { return dependencyCalls; }
    };
  } finally {
    Module._load = load;
  }
}

async function invokeRetiredAdminRoute(router, routePath) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert(layer, '旧管理端路由必须保留退役响应：' + routePath);
  let statusCode = 200;
  let body = null;
  await layer.route.stack[0].handle({
    body: new Proxy({}, { get() { throw new Error('退役端点不应读取请求体'); } })
  }, {
    status(value) { statusCode = value; return this; },
    json(value) { body = value; return value; }
  });
  return { statusCode, body };
}

(async () => {
  const grouped = verificationMatchModel.groupFileHashMatches(matchRows);
  assert.strictEqual(grouped.length, 2, '同一提交内的重复文件必须合并为一条审核记录');
  assert.strictEqual(grouped[0].matchingFiles.length, 2, '匹配文件必须完整保留');

  verificationAllowed = false;
  let access = await invokeVerificationAccess();
  assert.deepStrictEqual(access, { status: 'success', canVerify: false },
    '普通成员入口必须按当前组织验签授权失败关闭');
  const forbidden = await invokeVerification({ fileHash: 'same-hash' });
  assert.strictEqual(forbidden.status, 'forbidden', '未授予验证权限的普通成员不得看到匹配记录');
  verificationAllowed = true;
  access = await invokeVerificationAccess();
  assert.deepStrictEqual(access, { status: 'success', canVerify: true },
    '当前组织已授权成员必须获得可见验签入口');

  const first = await invokeVerification({ fileBase64: Buffer.from('same-file').toString('base64') });
  assert.strictEqual(first.status, 'success');
  assert.strictEqual(first.matchCount, 2, '文件验证必须返回全部匹配审核记录');
  assert.strictEqual(first.submissionId, 'submission-new', '首次展示可以选择排序后的第一条，但不得丢弃其他匹配项');
  assert.deepStrictEqual(first.matches.map((item) => item.submissionId), ['submission-new', 'submission-old']);
  assert(verificationQuery.sql.includes('asf.org_id = ?'), '匹配查询必须显式限制当前组织');
  assert.strictEqual(verificationQuery.params[1], 'org-current');
  assert(!verificationQuery.sql.includes('LIMIT 1'), '文件哈希查询不得只取最新一条');

  const selected = await invokeVerification({ fileHash: SAME_FILE_HASH, submissionId: 'submission-old' });
  assert.strictEqual(selected.status, 'success');
  assert.strictEqual(selected.submissionId, 'submission-old', '用户必须能切换查看任意匹配记录的签名链');
  assert.strictEqual(selected.matchCount, 2);
  assert.strictEqual(selected.verificationSource, 'record_lookup');
  assert.strictEqual(selected.valid, false, '哈希查询不得冒充上传验真');
  const mismatch = await invokeVerification({ fileBase64: Buffer.from('modified-file').toString('base64'), fileHash: SAME_FILE_HASH });
  assert.strictEqual(mismatch.status, 'invalid_params', '同时提交字节与摘要必须重算并一致');
  const emptyBytes = await invokeVerification({ fileBase64: '', fileHash: SAME_FILE_HASH });
  assert.strictEqual(emptyBytes.status, 'invalid_params', '出现文件字段但空值不得退回摘要查询');
  await verifyUploadsOverHttp();

  const escaped = await invokeVerification({ fileHash: SAME_FILE_HASH, submissionId: 'submission-other' });
  assert.strictEqual(escaped.status, 'not_found', '记录 ID 不属于当前文件哈希匹配集时必须失败关闭');

  const statusPresentation = presentVerificationResponse({
    submissionId: 'pending-record',
    matches: [
      { submissionId: 'pending-record', status: 'pending' },
      { submissionId: 'progress-record', status: 'in_progress' }
    ]
  });
  assert.strictEqual(statusPresentation.matches[0].statusText, '待提交', 'pending 必须表示待提交或待重新提交');
  assert.strictEqual(statusPresentation.matches[0].statusClass, 'verification-match-status--muted');
  assert.strictEqual(statusPresentation.matches[1].statusText, '审核中', 'in_progress 才表示审核进行中');
  assert.strictEqual(statusPresentation.matches[1].statusClass, 'verification-match-status--warning');

  const root = path.resolve(__dirname, '..', '..');
  const adminRouteSource = fs.readFileSync(path.join(root, 'server/src/modules/audit/routes/auditAdmin.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(root, 'server/src/index.js'), 'utf8');
  const userPageSource = fs.readFileSync(path.join(root, 'miniprogram/subpackages/audit/pages/verification/verification.wxml'), 'utf8');
  const adminPageSource = fs.readFileSync(path.join(root, 'miniprogram/subpackages/scoring/pages/admin/admin.wxml'), 'utf8');
  const userLogicSource = fs.readFileSync(path.join(root, 'miniprogram/subpackages/audit/pages/verification/verification.js'), 'utf8');
  const adminLogicSource = fs.readFileSync(path.join(root, 'miniprogram/subpackages/scoring/pages/admin/modules/auditBehavior.js'), 'utf8');

  assert(adminRouteSource.includes("router.post('/verifyAuditFile'"), '旧管理端路由名必须保留明确退役响应');
  assert(adminRouteSource.includes("status: 'legacy_api_retired'"), '无前端调用的重复管理端接口必须安全退役');
  assert(adminRouteSource.includes('res.status(410)'), '退役端点必须返回 HTTP 410');
  const retiredAdmin = loadRetiredAdminRouter();
  const retiredResponse = await invokeRetiredAdminRoute(retiredAdmin.router, '/verifyAuditFile');
  assert.strictEqual(retiredResponse.statusCode, 410, '退役端点必须实际返回 HTTP 410');
  assert.strictEqual(retiredResponse.body.status, 'legacy_api_retired');
  const retiredIdentityStamps = await invokeRetiredAdminRoute(retiredAdmin.router, '/listIdentityStamps');
  assert.strictEqual(retiredIdentityStamps.statusCode, 410, '重复印章列表端点必须实际返回 HTTP 410');
  assert.strictEqual(retiredIdentityStamps.body.status, 'legacy_api_retired');
  assert.strictEqual(retiredAdmin.getDependencyCalls(), 0, '退役端点不得读取数据库或业务模型');
  assert(indexSource.includes("'/api/verifySignatureChain'"), '文件签名验证必须使用受控的大请求体解析额度');
  const largeRouteBlock = indexSource.match(/const LARGE_JSON_ROUTES = new Set\(\[[\s\S]*?\]\);/);
  assert(largeRouteBlock, '必须保留大请求体路由清单');
  assert(!largeRouteBlock[0].includes("'/api/verifyAuditFile'"), '退役端点不得继续保留文件上传解析契约');
  assert(!userLogicSource.includes("name: 'verifyAuditFile'"));
  assert(!adminLogicSource.includes("'verifyAuditFile'"));
  [userPageSource, adminPageSource].forEach((source) => {
    assert(source.includes('verificationResult.matches') || source.includes('result.matches'), '两个前端入口都必须渲染全部匹配记录');
    assert(source.includes('selectVerificationMatch'), '两个前端入口都必须允许切换查看每条签名链');
  });
  [userLogicSource, adminLogicSource].forEach((source) => {
    assert(source.includes('buildMatchVerificationParams'), '选择记录时必须同时提交文件哈希与审核记录 ID');
  });

  console.log('审核文件多记录匹配、组织隔离与前端选择契约测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
