'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_USER = process.env.DB_USER || 'security-test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'security-test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-storage-maintenance-test-secret';

const {
  createAuditFileStorageMaintenance
} = require('../src/modules/audit/services/auditFileStorageMaintenance');

function writeOldFile(filePath, now) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from('fixture'));
  const oldTime = new Date(now - 48 * 60 * 60 * 1000);
  fs.utimesSync(filePath, oldTime, oldTime);
}

function createDatabase(referencedPaths, activeTempNames, evidencePaths = []) {
  const references = new Set(referencedPaths);
  return {
    async query(sql, params) {
      if (sql.includes('FROM audit_signing_evidence')) return [evidencePaths.filter(file => params.includes(file))
        .map(file => ({ input_file_path: file, output_file_path: file }))];
      if (sql.includes('SELECT file_path') && sql.includes("file_path <> ''")) {
        return [Array.from(references).map((filePath) => ({ file_path: filePath }))];
      }
      if (sql.includes('SELECT temp_name')) {
        return [activeTempNames.map((tempName) => ({ temp_name: tempName }))];
      }
      if (sql.includes('SELECT id') && sql.includes('WHERE file_path = ?')) {
        return [references.has(params[0]) ? [{ id: 'referenced-file' }] : []];
      }
      if (sql.includes('DELETE FROM audit_temp_uploads')) return [{ affectedRows: 2 }];
      throw new Error('未处理 SQL: ' + sql);
    }
  };
}

(async () => {
  const now = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-storage-maintenance-'));
  const tempDir = path.join(root, '_tmp');
  const submissionDir = path.join(root, 'submission-1');
  const activeTemp = path.join(tempDir, 'active.png');
  const orphanTemp = path.join(tempDir, 'orphan.png');
  const referencedPermanent = path.join(submissionDir, 'referenced.pdf');
  const orphanPermanent = path.join(submissionDir, 'orphan.pdf');
  const evidencePermanent = path.join(submissionDir, 'historical-evidence.pdf');
  const legacyReferencedPermanent = path.join(submissionDir, 'legacy-reference.pdf');
  const missingReferenced = path.join(submissionDir, 'missing.pdf');
  const protectedInternal = path.join(root, '_keys', 'private-key.pdf');

  [activeTemp, orphanTemp, referencedPermanent, orphanPermanent, legacyReferencedPermanent, protectedInternal, evidencePermanent]
    .forEach((filePath) => writeOldFile(filePath, now));

  const maintenance = createAuditFileStorageMaintenance({
    database: createDatabase([
      referencedPermanent,
      missingReferenced,
      path.join('legacy-storage', 'legacy-reference.pdf')
    ], ['active.png'], [evidencePermanent]),
    uploadDir: root,
    orphanGraceMs: 24 * 60 * 60 * 1000,
    logger: { info() {}, error() {} }
  });
  const report = await maintenance.runOnce(now);

  assert.strictEqual(fs.existsSync(activeTemp), true, '有效临时配额对应文件必须保留');
  assert.strictEqual(fs.existsSync(orphanTemp), false, '超过宽限期且无临时记录的文件应清理');
  assert.strictEqual(fs.existsSync(referencedPermanent), true, '任何数据库引用文件都不得删除');
  assert.strictEqual(fs.existsSync(evidencePermanent), true, '仅被历史密码凭证引用的旧文件版本也必须保留');
  assert.strictEqual(fs.existsSync(legacyReferencedPermanent), true, '旧相对路径引用也必须按唯一文件名保守保留');
  assert.strictEqual(fs.existsSync(orphanPermanent), false, '超过宽限期且无数据库引用的正式附件应清理');
  assert.strictEqual(fs.existsSync(protectedInternal), true, '下划线内部目录不属于附件孤儿清理范围');
  assert.strictEqual(report.temporaryOrphansRemoved, 1);
  assert.strictEqual(report.permanentOrphansRemoved, 1);
  assert.strictEqual(report.expiredReservationsRemoved, 2);
  assert.strictEqual(report.missingReferencedFiles, 1, '数据库引用缺文件只报告，不修改数据库引用');

  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(root).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(referencedPermanent).mode & 0o777, 0o600);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('审核附件权限、宽限期孤儿清理与数据库引用保护测试通过');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
