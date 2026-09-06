'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const forge = require('node-forge');
const { PDFDocument } = require('pdf-lib');
const { createSignerCertificate } = require('../src/modules/audit/utils/pdfSignature');
const { signCms, verifyCms } = require('../src/modules/audit/utils/cmsSignature');
const { signPdfBuffer, verifyPdfSignature } = require('../src/modules/audit/utils/pdfSignedDocument');
const { createReceipt, verifyReceipt, buildManifest, verifyManifest } = require('../src/modules/audit/services/signingEvidenceProtocol');
const { canonicalize, sha256, assertManifest, decodeBase64, MAX_FILE_BYTES } = require('../src/modules/audit/utils/signingProtocol');
const { verifyPdfBytes } = require('../src/modules/audit/services/pdfVerification');

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const certificatePem = createSignerCertificate(forge.pki.privateKeyFromPem(pair.privateKey), forge.pki.publicKeyFromPem(pair.publicKey), '平台测试证书', '20990001', '测试组织');
const active = { version: 'test-v1', hmacKey: crypto.randomBytes(32), encryptionKey: crypto.randomBytes(32),
  identity: { privateKeyPem: pair.privateKey, certificatePem }, fingerprint: sha256(new crypto.X509Certificate(certificatePem).raw), revoked: false };
const keyring = { active, versions: new Map([[active.version, active]]) };
function options(overrides) {
  return { actor: { person_id: 'person-a', name: '同名', student_id: '20990001', assignment_id: 'assignment-a' },
    organizationId: 'org-a', organizationName: '测试组织', assignmentLabel: '测试岗位', action: 'approve',
    time: new Date().toISOString(), round: 1, step: 1, eventId: 'event-a', fileId: 'file-a', submissionId: 'submission-a',
    inputDigest: sha256('input'), outputDigest: sha256('output'), outputDigestType: 'file_sha256', materialsDigest: sha256('[]'), ...overrides };
}
function row(receipt, opts) {
  return { id: receipt.ref, receipt_digest: receipt.receiptDigest, key_version: receipt.keyVersion,
    certificate_fingerprint: receipt.fingerprint, identity_ciphertext: receipt.identityCiphertext,
    person_id: opts.actor.person_id, assignment_id: opts.actor.assignment_id, org_id: opts.organizationId,
    event_id: opts.eventId, file_id: opts.fileId, submission_id: opts.submissionId,
    input_digest: opts.inputDigest, previous_digest: opts.previous || '', action_type: opts.action,
    signed_at: opts.time, payload_json: receipt.payload,
    output_digest: opts.outputDigest, output_digest_type: opts.outputDigestType,
    step_index: opts.step, round: opts.round, cms_base64: receipt.cms };
}

test('JCS 拒绝孤立代理字符，排序稳定且保留字符串事实', () => {
  assert.equal(canonicalize({ b: 2, a: '中文' }), '{"a":"中文","b":2}');
  assert.throws(() => canonicalize('\ud800'));
  assert.throws(() => canonicalize(NaN));
});
test('新证书绝不包含兼容参数中的学号', () => {
  assert(!new crypto.X509Certificate(certificatePem).subject.includes('20990001'));
});
test('Base64 支持完整 10 MiB 上限，拒绝超限和非规范编码', () => {
  const input = Buffer.alloc(MAX_FILE_BYTES, 0xa5);
  assert.deepEqual(decodeBase64(input.toString('base64'), MAX_FILE_BYTES), input);
  assert.throws(() => decodeBase64(Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64'), MAX_FILE_BYTES));
  for (const invalid of ['', 'AA', 'AA===', 'A===', 'AB==', 'AAB=', 'AA=A', 'AA\n=', '====', 'AA-_']) {
    assert.throws(() => decodeBase64(invalid, MAX_FILE_BYTES), invalid);
  }
  for (const size of [1, 2, 3, 4]) {
    const small = Buffer.alloc(size, 0xff);
    assert.deepEqual(decodeBase64(small.toString('base64'), size), small);
  }
});
test('同名不同人精确绑定，篡改人员/组织/密文必须失败', () => {
  const opts = options();
  const receipt = createReceipt(opts, keyring);
  const record = row(receipt, opts);
  assert.equal(verifyReceipt(receipt.cms, record, keyring).ok, true);
  const publicContent = verifyCms(Buffer.from(receipt.cms, 'base64'), null).content.toString('utf8');
  assert(!publicContent.includes('20990001'));
  assert(!publicContent.includes('person-a'));
  for (const patch of [{ person_id: 'person-b' }, { org_id: 'org-b' }, { identity_ciphertext: '{}' }, { file_id: 'file-b' }]) {
    assert.equal(verifyReceipt(receipt.cms, { ...record, ...patch }, keyring).ok, false);
  }
  assert.equal(verifyReceipt(receipt.cms, record, { versions: new Map() }).reasonCode, 'evidence_key_unavailable');
});
test('链缺失、调序、跨文件移植均不能通过', () => {
  const firstOpts = options();
  const first = createReceipt(firstOpts, keyring);
  const firstRow = row(first, firstOpts);
  const secondOpts = options({ step: 2, eventId: 'event-b', previous: first.receiptDigest, inputDigest: firstOpts.outputDigest });
  const second = createReceipt(secondOpts, keyring);
  const secondRow = row(second, secondOpts);
  const manifest = buildManifest([firstRow], second, false);
  assert.equal(verifyManifest(manifest, [firstRow, secondRow], keyring).ok, true);
  assert.equal(verifyManifest(manifest, [secondRow, firstRow], keyring).ok, false);
  assert.equal(verifyManifest(manifest, [firstRow], keyring).ok, false);
});
test('CMS 缺失/重复属性、同公钥替换证书和非 DER 编码均拒绝', () => {
  const content = Buffer.from('cms-adversarial-content');
  const encoded = signCms(content, active.identity);
  function mutate(fn) {
    const root = forge.asn1.fromDer(encoded.toString('binary'));
    fn(root.value[1].value[0].value);
    return Buffer.from(forge.asn1.toDer(root).getBytes(), 'binary');
  }
  const duplicate = mutate(body => { const attrs = body[4].value[0].value[3].value; attrs.push(attrs[0]); });
  assert.equal(verifyCms(duplicate, content).reasonCode, 'cms_attribute_duplicate');
  const missing = mutate(body => { body[4].value[0].value[3].value = []; });
  assert.equal(verifyCms(missing, content).ok, false);
  const substituted = mutate(body => {
    const replacement = body[3].value[0];
    const tbs = replacement.value[0];
    // 只改主体，原样保留 issuer/serial/SPKI，保证必须依赖 ESS 证书绑定才能识别替换。
    tbs.value[5].value[0].value[0].value[1].value = 'Replacement Certificate';
    const tbsDer = Buffer.from(forge.asn1.toDer(tbs).getBytes(), 'binary');
    replacement.value[2].value = '\x00' + crypto.sign('sha256', tbsDer, pair.privateKey).toString('binary');
  });
  assert.equal(verifyCms(substituted, content).reasonCode, 'cms_certificate_binding_invalid');
  const wrongSid = mutate(body => { body[4].value[0].value[1].value[1].value = '\x01'; });
  assert.equal(verifyCms(wrongSid, content).reasonCode, 'cms_certificate_not_found');
  const indefinite = Buffer.from(encoded); indefinite[1] = 128;
  assert.equal(verifyCms(indefinite, content).reasonCode, 'cms_length_invalid');
  assert.equal(verifyCms(Buffer.alloc(2 * 1024 * 1024 + 1), content).reasonCode, 'cms_size_invalid');
  assert.throws(() => assertManifest({ version: 2, legacyPrefix: false, receipts: Array(257).fill('AA==') }));
  assert.throws(() => assertManifest({ version: 2, legacyPrefix: false, receipts: ['A'.repeat(1024 * 1024)] }));
});
test('OpenSSL 独立验真，同时验证 OpenSSL 生成的标准 CMS', () => {
  const executable = process.env.TEST_OPENSSL_PATH || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
    ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whusu-cms-test-'));
  try {
    const content = Buffer.from('independent-test-content');
    fs.writeFileSync(path.join(dir, 'input.bin'), content);
    fs.writeFileSync(path.join(dir, 'key.pem'), pair.privateKey, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'cert.pem'), certificatePem);
    fs.writeFileSync(path.join(dir, 'ours.der'), signCms(content, active.identity));
    execFileSync(executable, ['cms', '-verify', '-binary', '-inform', 'DER', '-in', 'ours.der', '-content', 'input.bin', '-noverify', '-out', 'verified.bin'], { cwd: dir, stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'verified.bin')), content);
    execFileSync(executable, ['cms', '-sign', '-binary', '-in', 'input.bin', '-signer', 'cert.pem', '-inkey', 'key.pem', '-outform', 'DER', '-out', 'external.der', '-md', 'sha256'], { cwd: dir, stdio: 'pipe' });
    const external = fs.readFileSync(path.join(dir, 'external.der'));
    assert.equal(verifyCms(external, content).ok, true);
    assert.equal(verifyCms(external, Buffer.from('modified')).ok, false);
  } finally {
    for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
    fs.rmdirSync(dir);
  }
});
test('最终 PDF 清单绑定实际 ByteRange；附加内容和修改字节失败', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  let receipt;
  let record;
  const signed = await signPdfBuffer(Buffer.from(await doc.save()), pair.privateKey, certificatePem, {
    signer: { name: '同名' },
    createManifest(bytes) {
      const opts = options({ outputDigest: sha256(bytes), outputDigestType: 'pdf_byte_range_sha256' });
      receipt = createReceipt(opts, keyring);
      record = row(receipt, opts);
      return buildManifest([], receipt, false);
    }
  });
  const checked = verifyPdfSignature(signed);
  assert.equal(checked.valid, true, JSON.stringify(checked));
  const isolated = await verifyPdfBytes(signed);
  assert.equal(isolated.valid, true, JSON.stringify(isolated));
  assert.equal(verifyManifest(checked.signatures[0].manifest, [record], keyring, checked.signatures[0].signedBytesDigest).ok, true);
  assert.equal(verifyPdfSignature(Buffer.concat([signed, Buffer.from('\n% appended')])).valid, false);
  const modified = Buffer.from(signed);
  modified[20] ^= 1;
  assert.equal(verifyPdfSignature(modified).valid, false);
});
