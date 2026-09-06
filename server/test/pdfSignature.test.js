'use strict';

const assert = require('assert');
const { PDFDocument } = require('pdf-lib');
const forge = require('node-forge');
const {
  generateSigningKeyPair,
  createSignerCertificate,
  signPdfBuffer,
  verifyPdfSignature
} = require('../src/modules/audit/utils/pdfSignature');

async function buildBlankPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

function buildTestParentCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'WHUSU Test Parent CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert)
  };
}

(async () => {
  const pdf = await buildBlankPdf();
  const pair = generateSigningKeyPair();
  const certPem = createSignerCertificate(
    pair.privateKey,
    pair.publicKey,
    '张三',
    '20210001',
    '武汉大学第四十四届学生会'
  );
  const nodeCert = new (require('crypto').X509Certificate)(certPem);
  assert(nodeCert.subject.includes('张三'), '证书 DN 应包含真实姓名（严格 X.509 解析）');
  assert(!nodeCert.subject.includes('20210001'), '证书 DN 严禁包含学号（严格 X.509 解析）');

  const signed = await signPdfBuffer(pdf, pair.privateKeyPem, certPem, {
    signer: { name: '张三', studentId: '20210001', orgName: '武汉大学第四十四届学生会' },
    signaturePosition: { x: 0.5, y: 0.5, page: 1 }
  });
  assert(signed.includes('/Type /Sig'), '签名后 PDF 应包含签名对象');
  assert(signed.includes('/ByteRange ['), '签名后 PDF 应包含 ByteRange');
  assert(signed.includes('/Name (WHUSU Smart Workspace)'), '签名元数据不应包含乱码');
  assert(!/\/Name \([^)]*[\x80-\xff]/.test(signed.toString('binary')), '签名元数据不应出现非 ASCII 乱码');

  const verify = verifyPdfSignature(signed);
  assert.strictEqual(verify.present, true, '应识别出 PDF 数字签名');
  assert.strictEqual(verify.valid, true, '数字签名应有效');
  assert.strictEqual(verify.signatures.length, 1, '应解析出 1 个签名');
  assert.strictEqual(verify.signatures[0].ok, true, '签名校验应通过');
  assert.strictEqual(verify.signatures[0].trustStatus, 'not_evaluated', '未完成信任链验证不得标为可信');
  assert.strictEqual(verify.trusted, false, '自签名证书不应被报告为受信');
  assert.strictEqual(verify.signatures[0].signerName, '张三', '签名人姓名应为真实姓名');
  assert.strictEqual(verify.signatures[0].studentId, undefined, '验签响应不得返回学号');

  const parent = buildTestParentCertificate();
  const childPair = generateSigningKeyPair();
  const childCert = createSignerCertificate(
    childPair.privateKey,
    childPair.publicKey,
    '李四',
    '20210002',
    '武汉大学第四十四届学生会',
    parent
  );
  const parentSigned = await signPdfBuffer(pdf, childPair.privateKeyPem, childCert, {
    signer: { name: '李四', studentId: '20210002', orgName: '武汉大学第四十四届学生会' },
    certificateChainPem: parent.certificatePem,
    signaturePosition: { x: 0, y: 1, page: 1 }
  });
  const parentVerify = verifyPdfSignature(parentSigned);
  assert.strictEqual(parentVerify.valid, true, '父证书签发的数字签名应有效');
  assert.strictEqual(parentVerify.trusted, false, '携带父证书链不能视为信任链通过');
  assert.strictEqual(parentVerify.signatures[0].trustStatus, 'not_evaluated', '外部信任需独立验证');

  // 篡改签名覆盖区内的内容 → 验签必须失败
  const tampered = Buffer.from(signed);
  const sigTagIndex = tampered.indexOf('/Type /Sig');
  assert(sigTagIndex >= 0, '应能找到签名对象标记');
  tampered[sigTagIndex] = tampered[sigTagIndex] === 0x53 ? 0x54 : 0x53;
  const verifyTampered = verifyPdfSignature(tampered);
  assert.strictEqual(verifyTampered.valid, false, '篡改后验签必须失败');

  console.log('PDF 数字签名测试通过：姓名、学号隐私、篡改检测与外部信任边界');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
