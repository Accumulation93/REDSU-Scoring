'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { PDFDocument } = require('pdf-lib');
const { provision } = require('../scripts/provisionSigningEvidence');
const { sha256 } = require('../src/modules/audit/utils/signingProtocol');
const { loadKeyring } = require('../src/modules/audit/services/signingEvidenceKeys');

if (!process.env.DEPLOY_TEST_DB_HOST) {
  console.log('未配置 DEPLOY_TEST_DB_HOST，跳过密码凭证数据库集成测试');
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whusu-evidence-integration-'));
const database = 'whusu_evidence_test_' + process.pid + '_' + Date.now();
const testUser = 'evidence_' + process.pid;
const testPassword = crypto.randomBytes(24).toString('base64');
const testHost = process.env.TEST_DB_USER_HOST === '%' ? '%' : 'localhost';
const config = { host: process.env.DEPLOY_TEST_DB_HOST, port: Number(process.env.DEPLOY_TEST_DB_PORT || 3306),
  user: process.env.DEPLOY_TEST_DB_USER || 'root', password: process.env.DEPLOY_TEST_DB_PASSWORD || '', multipleStatements: true };

async function run() {
  const admin = await mysql.createConnection(config);
  let pool;
  try {
    await admin.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await admin.query("CREATE USER '" + testUser + "'@'" + testHost + "' IDENTIFIED BY ?", [testPassword]);
    await admin.query("GRANT ALL ON `" + database + "`.* TO '" + testUser + "'@'" + testHost + "'");
    await admin.changeUser({ database });
    await admin.query(fs.readFileSync(path.join(__dirname, '../db/init.sql'), 'utf8'));
    const migration = fs.readFileSync(path.join(__dirname, '../db/deploy/20260906180000_audit_signing_evidence.sql'), 'utf8');
    await admin.query(migration);
    await admin.query(migration);
    process.env.DB_HOST = config.host;
    process.env.DB_PORT = String(config.port);
    process.env.DB_USER = testUser;
    process.env.DB_PASSWORD = testPassword;
    process.env.DB_NAME = database;
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('base64');
    process.env.AUDIT_UPLOAD_DIR = path.join(root, 'uploads');
    const primary = path.join(root, 'keys', 'keyring.json');
    const backup = path.join(root, 'backup', 'keyring.json');
    provision(primary, backup);
    const before = fs.readFileSync(primary);
    provision(primary, backup);
    assert.deepEqual(fs.readFileSync(primary), before, '重试不得生成新的密钥');
    pool = require('../src/config/db');
    const { orgStorage } = require('../src/utils/orgContext');
    const evidenceModel = require('../src/modules/audit/models/signingEvidence');
    const eventModel = require('../src/modules/audit/models/auditEvent');
    const fileModel = require('../src/modules/audit/models/auditSubmissionFile');
    const { prepareEvidence } = require('../src/modules/audit/services/approvalSigningEvidence');
    const { verifySubmissionFiles, verifyUnmatchedUpload } = require('../src/modules/audit/services/signingVerification');
    const { createAuditFileCommit } = require('../src/modules/audit/services/auditFileCommitCoordinator');
    const pdf = await PDFDocument.create(); pdf.addPage();
    let bytes = Buffer.from(await pdf.save());
    let filePath = path.join(process.env.AUDIT_UPLOAD_DIR, 'case', 'document.pdf');
    fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes);
    await admin.query("INSERT INTO audit_submissions (id, submission_number, submitted_by, org_id, status) VALUES ('case', 'CASE', 'author', 'org-a', 'pending')");
    await admin.query("INSERT INTO audit_submission_files (id, submission_id, file_name, file_path, file_size, file_hash, mime_type, org_id) VALUES ('file', 'case', 'document.pdf', ?, ?, ?, 'application/pdf', 'org-a')", [filePath, bytes.length, sha256(bytes)]);
    for (let step = 1; step <= 3; step += 1) await admin.query("INSERT INTO audit_submission_steps (id, submission_id, sort_order, action_type, org_id) VALUES (?, 'case', ?, 'pass', 'org-a')", ['step-' + step, step]);
    await orgStorage.run('org-a', async () => {
      let round = 1;
      async function processStep(step, action, rollback) {
        const conn = await pool.getConnection();
        let commit;
        try {
          await conn.beginTransaction();
          const stepId = round === 1 ? 'step-' + step : 'r' + round + '-step-' + step;
          await conn.query("SELECT id FROM audit_submission_steps WHERE org_id = 'org-a' AND id = ? FOR UPDATE", [stepId]);
          const context = { db: conn, organizationId: 'org-a', organizationName: '测试组织',
            actor: { person_id: 'person-' + (round === 3 && step === 2 ? 1 : step), assignment_id: 'assignment-' + step,
              name: '同名人员', student_id: '2099' + (round === 3 && step === 2 ? 1 : step) },
            assignmentLabel: '审批岗位 ' + step, submissionId: 'case', stepId, eventId: 'r' + round + '-event-' + step,
            fileId: 'file', round, step, action, time: new Date().toISOString(), inputDigest: sha256(bytes), inputPath: filePath,
            buffer: bytes, finalPdf: step === 3 && action !== 'reject', materials: [] };
          const evidence = await prepareEvidence(context);
          commit = createAuditFileCommit([{ fileId: 'file', orgId: 'org-a', oldPath: filePath, buffer: evidence.buffer,
            mimeType: 'application/pdf', fileHash: sha256(evidence.buffer) }]);
          commit.stage();
          const metadata = commit.metadataFor('file');
          await fileModel.updateMetadata('file', metadata, conn);
          await evidenceModel.create(evidence.receipt, { ...evidence.context, outputPath: metadata.filePath }, conn);
          await eventModel.create(context.eventId, { submissionId: 'case', eventType: action === 'reject' ? 'reject' : 'approve',
            stepIndex: step, round, operatorPersonId: context.actor.person_id, operatorAssignmentId: context.actor.assignment_id }, conn);
          await conn.query('UPDATE audit_submission_steps SET status = ?, processed_person_id = ?, processed_assignment_id = ? WHERE id = ? AND org_id = ?',
            [action === 'reject' ? 'rejected' : 'approved', context.actor.person_id, context.actor.assignment_id, context.stepId, 'org-a']);
          if (rollback) { await conn.rollback(); commit.rollback(); return; }
          await conn.commit(); commit.finalize(); bytes = evidence.buffer; filePath = metadata.filePath;
        } catch (error) { await conn.rollback(); if (commit) commit.rollback(); throw error; }
        finally { conn.release(); }
      }
      await processStep(1, 'pass', true);
      assert.equal((await evidenceModel.listBySubmission('case')).length, 0, '事务回滚不留凭证');
      await processStep(1, 'pass');
      await processStep(2, 'sign');
      await processStep(3, 'stamp');
      const verified = await verifySubmissionFiles({ id: 'case' }, { uploadedBytes: bytes });
      assert.equal(verified.valid, true, JSON.stringify(verified));
      assert.equal(verified.verificationSource, 'uploaded_file');
      assert.equal(verified.files[0].steps.length, 3);
      assert.equal(verified.files[0].checks.externalTrust.status, 'indeterminate');
      assert.deepEqual(verified.files[0].steps.map(item => item.personIndex), [1, 2, 3], '同名不同人保持独立编号');
      assert.equal(verified.files[0].certificates.length, 1);
      const exported = verified.files[0].certificates[0];
      const exportedCertificate = new crypto.X509Certificate(Buffer.from(exported.derBase64, 'base64'));
      assert.equal(sha256(exportedCertificate.raw), exported.fingerprint);
      assert.equal(exported.fingerprint, verified.files[0].cms[0].certificateFingerprint);
      assert(!exportedCertificate.subject.includes('2099'));
      assert.equal(exportedCertificate.raw.toString('base64'), exported.derBase64);
      for (const student of ['20991', '20992', '20993']) assert(!JSON.stringify(verified).includes(student));
      assert(!JSON.stringify(verified).includes('person-1'));
      const recordOnly = await verifySubmissionFiles({ id: 'case' }, { source: 'record_lookup' });
      assert.equal(recordOnly.valid, false);
      const corrupted = Buffer.concat([bytes, Buffer.from('\n% changed')]);
      const unknown = await verifyUnmatchedUpload(corrupted);
      assert.equal(unknown.overallStatus, 'failed');
      assert(!JSON.stringify(unknown).includes('同名人员'), '无匹配上传不得泄露平台人员身份');
      assert(!unknown.files[0].certificates?.length, '未验真上传不能导出其中提供的任意证书');
      const forge = require('node-forge');
      const { createSignerCertificate } = require('../src/modules/audit/utils/pdfSignature');
      const { signPdfBuffer } = require('../src/modules/audit/utils/pdfSignedDocument');
      const foreignKey = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const foreignCert = createSignerCertificate(forge.pki.privateKeyFromPem(foreignKey.privateKey),
        forge.pki.publicKeyFromPem(foreignKey.publicKey), 'WHUSU Platform Attestation', '', 'WHUSU');
      const foreignDocument = await PDFDocument.create(); foreignDocument.addPage();
      const foreignPdf = await signPdfBuffer(Buffer.from(await foreignDocument.save()), foreignKey.privateKey, foreignCert,
        { signer: { name: 'WHUSU Platform Attestation' } });
      const external = await verifyUnmatchedUpload(foreignPdf);
      assert.equal(external.files[0].checks.cmsSignature.status, 'passed');
      assert.equal(external.files[0].checks.documentIntegrity.status, 'passed');
      assert.equal(external.valid, false, '自签 PDF 有效不等于平台签署');
      assert.equal(external.overallStatus, 'indeterminate');
      assert.notEqual(external.files[0].checks.platformCertificate.status, 'passed');
      assert.notEqual(external.files[0].checks.identityBinding.status, 'passed');
      assert.equal(external.files[0].steps.length, 0);
      assert(!external.files[0].certificates?.length, '禁止把攻击者证书作为平台证书导出');
      assert(!JSON.stringify(external).includes('同名人员'));
      const { verifyPdfSignature } = require('../src/modules/audit/utils/pdfSignedDocument');
      const { verifyFile } = require('../src/modules/audit/services/signingVerification');
      const copiedManifest = verifyPdfSignature(bytes).signatures[0].manifest;
      const transplantedPdf = await signPdfBuffer(Buffer.from(await foreignDocument.save()), foreignKey.privateKey, foreignCert,
        { createManifest: () => copiedManifest });
      const registeredFile = (await fileModel.getBySubmissionId('case'))[0];
      const transplanted = await verifyFile(transplantedPdf, { ...registeredFile, file_hash: sha256(transplantedPdf) }, {
        rows: await evidenceModel.listBySubmission('case'), events: await evidenceModel.listEventFacts('case'),
        certificates: await evidenceModel.listCertificates()
      });
      assert.equal(transplanted.overallStatus, 'failed', '移植真清单并用任意私钥重签不能获得平台认可');
      assert.notEqual(transplanted.checks.identityBinding.status, 'passed');
      assert.equal(transplanted.steps.length, 0);
      assert(!transplanted.certificates?.length);
      // 仅测试脚本输出公开结果与合成文件，供开发者工具现场验收；不进入小程序生产依赖。
      if (process.env.SIGNING_UI_FIXTURE_DIR) {
        const fixtureDir = path.resolve(process.env.SIGNING_UI_FIXTURE_DIR);
        fs.mkdirSync(fixtureDir, { recursive: true });
        fs.writeFileSync(path.join(fixtureDir, 'normal.pdf'), bytes);
        fs.writeFileSync(path.join(fixtureDir, 'tampered.pdf'), corrupted);
        fs.writeFileSync(path.join(fixtureDir, 'results.json'), JSON.stringify({ normal: verified, tampered: unknown }));
      }
      if (process.env.SIGNING_UI_PREVIEW_PORT) {
        await require('./helpers/signingUiPreview').serveSigningUiPreview({
          port: Number(process.env.SIGNING_UI_PREVIEW_PORT), originalBytes: bytes,
          verifyKnown: uploadedBytes => orgStorage.run('org-a', () => verifySubmissionFiles({ id: 'case' }, { uploadedBytes })),
          verifyUnknown: uploadedBytes => orgStorage.run('org-a', () => verifyUnmatchedUpload(uploadedBytes))
        });
      }
      const rows = await evidenceModel.listBySubmission('case');
      assert.equal(rows.length, 3);
      await assert.rejects(admin.query("DELETE FROM audit_submission_files WHERE id = 'file'"), /foreign key/i);
      await admin.query("UPDATE audit_events SET operator_person_id = 'forged' WHERE id = 'r1-event-2'");
      const forged = await verifySubmissionFiles({ id: 'case' });
      assert.equal(forged.valid, false);
      assert.equal(forged.files[0].checks.identityBinding.reasonCode, 'evidence_event_mismatch');
      assert(!forged.files[0].certificates?.length);
      await admin.query("UPDATE audit_events SET operator_person_id = 'person-2' WHERE id = 'r1-event-2'");
      await assert.rejects(processStep(3, 'stamp'), /evidence_chain_incomplete/);
      assert.equal((await evidenceModel.listBySubmission('case')).length, 3, '网络重试不得重复签署事实');
      round = 2;
      await fileModel.setCurrentRevisionRound('case', round, pool);
      await admin.query("INSERT INTO audit_submission_steps (id, submission_id, sort_order, round, action_type, org_id) VALUES ('r2-step-1', 'case', 1, 2, 'pass', 'org-a')");
      const pendingRound = await verifySubmissionFiles({ id: 'case' });
      assert.equal(pendingRound.valid, false, '新轮次尚未处理时不能用旧轮凭证宣称通过');
      await processStep(1, 'reject');
      const rejectedRound = await verifySubmissionFiles({ id: 'case' });
      assert.equal(rejectedRound.valid, true, JSON.stringify(rejectedRound));
      assert.equal(rejectedRound.files[0].steps.length, 1);
      assert.equal(rejectedRound.files[0].steps[0].action, 'reject');
      assert.equal((await evidenceModel.listBySubmission('case')).length, 4, '旧轮次凭证仍完整保存');
      round = 3;
      await fileModel.setCurrentRevisionRound('case', round, pool);
      for (let step = 1; step <= 3; step += 1) await admin.query("INSERT INTO audit_submission_steps (id, submission_id, sort_order, round, action_type, org_id) VALUES (?, 'case', ?, 3, 'pass', 'org-a')", ['r3-step-' + step, step]);
      await processStep(1, 'pass');
      await processStep(2, 'pass');
      await processStep(3, 'pass');
      const resubmitted = await verifySubmissionFiles({ id: 'case' });
      assert.equal(resubmitted.valid, true, JSON.stringify(resubmitted));
      assert.equal(resubmitted.files[0].steps.length, 3);
      assert(resubmitted.files[0].steps.every(item => item.round === 3));
      assert.deepEqual(resubmitted.files[0].steps.map(item => item.personIndex), [1, 1, 2], '同人不同岗位不虚构为不同自然人');
      const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
      const imagePath = path.join(process.env.AUDIT_UPLOAD_DIR, 'case', 'attachment.png');
      fs.writeFileSync(imagePath, imageBytes);
      await admin.query("INSERT INTO audit_submission_files (id, submission_id, file_name, file_path, file_size, file_hash, mime_type, org_id, revision_round) VALUES ('image', 'case', 'attachment.png', ?, ?, ?, 'image/png', 'org-a', 3)", [imagePath, imageBytes.length, sha256(imageBytes)]);
      const extra = await pool.getConnection();
      try {
        await extra.beginTransaction();
        for (let step = 1; step <= 3; step += 1) {
          const evidence = await prepareEvidence({ db: extra, organizationId: 'org-a', organizationName: '测试组织',
            actor: { person_id: 'person-' + (step === 2 ? 1 : step), assignment_id: 'assignment-' + step,
              name: '同名人员', student_id: '2099' + (step === 2 ? 1 : step) },
            assignmentLabel: '审批岗位 ' + step, submissionId: 'case', stepId: 'r3-step-' + step, eventId: 'r3-event-' + step,
            fileId: 'image', round: 3, step, action: 'pass', time: new Date().toISOString(),
            inputDigest: sha256(imageBytes), inputPath: imagePath, buffer: imageBytes, finalPdf: false, materials: [] });
          await evidenceModel.create(evidence.receipt, { ...evidence.context, outputPath: imagePath }, extra);
        }
        await extra.commit();
      } catch (error) { await extra.rollback(); throw error; } finally { extra.release(); }
      const multiFile = await verifySubmissionFiles({ id: 'case' });
      assert.equal(multiFile.valid, true, JSON.stringify(multiFile));
      assert.equal(multiFile.files.length, 2);
      assert.deepEqual(multiFile.files[0].steps.map(item => item.personIndex), multiFile.files[1].steps.map(item => item.personIndex), '同一人的跨附件编号保持一致');
      assert(multiFile.files.every(file => file.steps.length === 3), 'PDF 与未改图层的非 PDF 都必须绑定每步凭证');
      await orgStorage.run('org-b', async () => assert.equal((await evidenceModel.listBySubmission('case')).length, 0));
      assert.equal(loadKeyring({ forSigning: false }).active.version, 'v1');
    });
    console.log('密码凭证集成通过：幂等迁移、密钥恢复副本、三步同名人员、事务回滚、真实上传、事件关联与跨组织隔离');
  } finally {
    if (pool) await pool.end();
    await admin.changeUser({ database: 'mysql' });
    await admin.query('DROP DATABASE IF EXISTS `' + database + '`');
    await admin.query("DROP USER IF EXISTS '" + testUser + "'@'" + testHost + "'");
    await admin.end();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
