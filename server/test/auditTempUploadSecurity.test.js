'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
process.env.DB_USER = process.env.DB_USER || 'security-test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'security-test';
const { createModel } = require('../src/core/models/auditTempUpload');

function createQuotaDatabase() {
  const rows = [];
  const events = [];
  return {
    rows,
    events,
    async getConnection() {
      return {
        async query(sql, params) {
          if (sql.includes('GET_LOCK')) {
            events.push('lock:' + params[0]);
            return [[{ acquired: 1 }]];
          }
          if (sql.includes('RELEASE_LOCK')) {
            events.push('release:' + params[0]);
            return [[{ released: 1 }]];
          }
          if (sql.includes('SELECT file_id, temp_name')) return [[]];
          if (sql.includes('SELECT COUNT(*)') && sql.includes('owner_hash = ?')) {
            const selected = rows.filter((row) => row.ownerHash === params[0]);
            return [[{
              file_count: selected.length,
              total_bytes: selected.reduce((sum, row) => sum + row.fileSize, 0)
            }]];
          }
          if (sql.includes('SELECT COUNT(*)')) {
            return [[{
              file_count: rows.length,
              total_bytes: rows.reduce((sum, row) => sum + row.fileSize, 0)
            }]];
          }
          if (sql.includes('INSERT INTO audit_temp_uploads')) {
            rows.push({
              fileId: params[0], ownerHash: params[1], orgId: params[2],
              tempName: params[3], fileSize: Number(params[4])
            });
            return [{ affectedRows: 1 }];
          }
          throw new Error('未处理 SQL: ' + sql);
        },
        async beginTransaction() { events.push('begin'); },
        async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); },
        release() { events.push('connection-release'); }
      };
    }
  };
}

async function testCrossProcessQuotaAndLocks() {
  const database = createQuotaDatabase();
  const limits = {
    accountFiles: 1,
    accountBytes: 10,
    globalFiles: 2,
    globalBytes: 20,
    lockTimeoutSeconds: 1
  };
  const processA = createModel(database, limits);
  const processB = createModel(database, limits);
  const expiresAt = new Date(Date.now() + 60000);
  await processA.reserve({
    fileId: 'file-a', ownerHash: 'owner-hash', orgId: 'org-1',
    tempName: 'file-a.png', fileSize: 6, expiresAt
  });
  await assert.rejects(
    () => processB.reserve({
      fileId: 'file-b', ownerHash: 'owner-hash', orgId: 'org-1',
      tempName: 'file-b.png', fileSize: 1, expiresAt
    }),
    (error) => error.code === 'upload_account_quota_exceeded'
  );
  assert.deepStrictEqual(database.events.slice(0, 2), [
    'lock:audit-upload:global',
    'lock:audit-upload:owner-hash'
  ]);
  const releaseEvents = database.events.filter((event) => event.startsWith('release:'));
  assert.strictEqual(releaseEvents.length, 4, '成功和拒绝路径都必须释放两把锁');
  assert(database.events.includes('rollback'), '配额拒绝必须回滚事务');
}

async function testRealTemporaryDirectory() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-upload-security-'));
  process.env.AUDIT_UPLOAD_DIR = temporaryRoot;
  process.env.JWT_SECRET = 'audit-upload-security-test-secret';
  process.env.AUTH_IDENTITY_SECRET = 'audit-upload-identity-test-secret-32-bytes';
  const quotaRows = new Map();
  const createdFiles = [];
  let failCreateForFileId = '';
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === '../../../config/db') {
      return {
        async query(sql) {
          assert(!/account_wechat_bindings|openid/.test(sql), '附件不得按微信重新查找账号');
          return [[]];
        }
      };
    }
    if (request === '../../../utils/orgContext') return { async getCurrentOrgId() { return 'org-1'; } };
    if (request === '../models/verificationPermission') return { async checkPermission() { return false; } };
    if (request === '../models/auditSubmissionFile') {
      return {
        async create(fileId, data) {
          if (fileId === failCreateForFileId) throw new Error('simulated database failure');
          createdFiles.push({ fileId, data });
        }
      };
    }
    if (request === '../models/auditSubmissionStep') return { async getPendingByApprover() { return []; } };
    if (request === '../../../core/services/currentActor') return { async resolveCurrentActor() { return { ok: false }; } };
    if (request === '../../../core/services/adminPermissions') return { hasAnyPermission() { return false; } };
    if (request === '../services/auditAssignmentContext') return { async resolveActorAssignment() { return null; } };
    if (request === '../../../middleware/auth') return { JWT_SECRET: process.env.JWT_SECRET };
    if (request === '../../../core/models/auditTempUpload') {
      return {
        async reserve(data) {
          quotaRows.set(data.fileId, data);
          return { expiredRows: [] };
        },
        async findActive(fileId, ownerHash, orgId) {
          const row = quotaRows.get(fileId);
          if (!row || row.ownerHash !== ownerHash || row.orgId !== orgId) return null;
          return { file_id: row.fileId, temp_name: row.tempName, file_size: row.fileSize };
        },
        async remove(fileId) { quotaRows.delete(fileId); }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const fileSecurityPath = require.resolve('../src/modules/audit/utils/fileSecurity');
    delete require.cache[fileSecurityPath];
    const fileSecurity = require(fileSecurityPath);
    Module._load = originalLoad;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]);
    await assert.rejects(
      () => fileSecurity.attachUploadedFiles({
        uploadedFiles: [], submissionId: 'submission-without-transaction', accountId: 'account-1'
      }),
      (error) => error.status === 'error'
    );
    const uploaded = await fileSecurity.createTempUpload({
      buffer: png,
      fileName: 'signature.png',
      mimeType: 'image/png',
      accountId: 'account-1',
      openid: 'plain-openid-must-not-be-stored'
    });
    const tempPath = path.join(temporaryRoot, '_tmp', uploaded.fileId + '.png');
    assert.strictEqual(fs.existsSync(tempPath), true, '必须在真实临时目录写入随机文件名');
    const tokenPayload = JSON.parse(Buffer.from(uploaded.fileToken.split('.')[0], 'base64url').toString('utf8'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(tokenPayload, 'openid'), false);
    assert.strictEqual(tokenPayload.ownerHash, fileSecurity.uploadOwnerHash('account-1'));
    assert.notStrictEqual(tokenPayload.ownerHash, fileSecurity.uploadOwnerHash('account-2'));
    assert.notStrictEqual(tokenPayload.ownerHash, 'plain-openid-must-not-be-stored');
    assert.strictEqual(JSON.stringify(Array.from(quotaRows.values())).includes('plain-openid-must-not-be-stored'), false);

    await assert.rejects(() => fileSecurity.createTempUpload({
      buffer: png, fileName: 'missing-account.png', mimeType: 'image/png', openid: 'bound-wechat'
    }), (error) => error.status === 'upload_quota_unavailable', '只有微信标识不能上传');
    await assert.rejects(() => fileSecurity.attachUploadedFiles({
      uploadedFiles: [{ fileToken: uploaded.fileToken }],
      submissionId: 'submission-wrong-account', accountId: 'account-2',
      openid: 'plain-openid-must-not-be-stored', conn: { async query() {} }
    }), (error) => error.status === 'forbidden', '同一微信不能读取另一口令账号的附件');
    assert.strictEqual(fs.existsSync(tempPath), true, '越权挂接不能移走附件');

    await fileSecurity.attachUploadedFiles({
      uploadedFiles: [{ fileToken: uploaded.fileToken }],
      submissionId: 'submission-1',
      accountId: 'account-1',
      openid: 'a-different-wechat-or-password-session',
      conn: { async query() {} }
    });
    assert.strictEqual(fs.existsSync(tempPath), false);
    assert.strictEqual(fs.existsSync(path.join(temporaryRoot, 'submission-1', uploaded.fileId + '.png')), true);
    assert.strictEqual(quotaRows.size, 0, '附件入库后必须释放临时配额');
    assert.strictEqual(createdFiles.length, 1);

    const validUnicodeName = '签'.repeat(500);
    const unicodeUpload = await fileSecurity.createTempUpload({
      buffer: png,
      fileName: validUnicodeName,
      mimeType: 'image/png',
      accountId: 'account-1'
    });
    assert.strictEqual(unicodeUpload.fileName, validUnicodeName, '文件名上限必须按 Unicode 字符而不是 UTF-16 单元计算');
    await assert.rejects(
      () => fileSecurity.createTempUpload({
        buffer: png,
        fileName: '😀'.repeat(501),
        mimeType: 'image/png',
        accountId: 'account-1'
      }),
      (error) => error.status === 'invalid_params'
    );

    const rollbackUploadA = unicodeUpload;
    const rollbackUploadB = await fileSecurity.createTempUpload({
      buffer: png,
      fileName: '第二个文件.png',
      mimeType: 'image/png',
      accountId: 'account-1'
    });
    failCreateForFileId = rollbackUploadB.fileId;
    await assert.rejects(() => fileSecurity.attachUploadedFiles({
      uploadedFiles: [
        { fileToken: rollbackUploadA.fileToken },
        { fileToken: rollbackUploadB.fileToken }
      ],
      submissionId: 'submission-rollback',
      accountId: 'account-1',
      conn: { async query() {} }
    }), /simulated database failure/);
    [rollbackUploadA, rollbackUploadB].forEach((item) => {
      assert.strictEqual(
        fs.existsSync(path.join(temporaryRoot, '_tmp', item.fileId + '.png')),
        true,
        '批次任一数据库写入失败时，已移动文件必须全部回到临时区'
      );
      assert.strictEqual(
        fs.existsSync(path.join(temporaryRoot, 'submission-rollback', item.fileId + '.png')),
        false
      );
    });

    if (process.platform !== 'win32') {
      const directoryMode = fs.statSync(path.join(temporaryRoot, '_tmp')).mode & 0o777;
      const fileMode = fs.statSync(path.join(temporaryRoot, '_tmp', rollbackUploadA.fileId + '.png')).mode & 0o777;
      assert.strictEqual(directoryMode, 0o700);
      assert.strictEqual(fileMode, 0o600);
    }
  } finally {
    Module._load = originalLoad;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

(async () => {
  await testCrossProcessQuotaAndLocks();
  await testRealTemporaryDirectory();
  console.log('审核临时目录、主体摘要、跨进程配额与锁释放测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
