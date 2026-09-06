'use strict';

// 只读诊断原始 PDF；独立 OpenSSL 验证不等于证书信任或平台身份验真。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyPdfSignature, extractCmsDerFromPdfContents } = require('../src/modules/audit/utils/pdfSignature');

function checkPdfInteroperability(buffer) {
  const result = verifyPdfSignature(buffer);
  const executable = process.env.TEST_OPENSSL_PATH || (process.platform === 'win32'
    ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whusu-pdf-check-'));
  try {
    const signatures = result.signatures.map(signature => {
      const range = signature.byteRange;
      const bytes = Buffer.concat([buffer.subarray(range[0], range[0] + range[1]), buffer.subarray(range[2], range[2] + range[3])]);
      fs.writeFileSync(path.join(directory, 'content.bin'), bytes);
      fs.writeFileSync(path.join(directory, 'signature.der'), extractCmsDerFromPdfContents(buffer, range));
      execFileSync(executable, ['cms', '-verify', '-binary', '-inform', 'DER', '-in', 'signature.der',
        '-content', 'content.bin', '-noverify', '-out', 'verified.bin'], { cwd: directory, stdio: 'pipe' });
      if (!fs.readFileSync(path.join(directory, 'verified.bin')).equals(bytes)) throw new Error('openssl_content_mismatch');
      return { byteRange: range, cmsValid: signature.cmsValid, wholeDocument: signature.wholeDocument,
        opensslValid: true, certificateFingerprint: signature.certificateFingerprint,
        receiptCount: signature.manifest ? signature.manifest.receipts.length : 0 };
    });
    return { valid: result.valid, reasonCode: result.reasonCode, externalTrust: 'not_evaluated', signatures };
  } finally {
    for (const name of ['content.bin', 'signature.der', 'verified.bin']) {
      const target = path.join(directory, name);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.rmdirSync(directory);
  }
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error('pdf_path_required');
  const result = checkPdfInteroperability(fs.readFileSync(process.argv[2]));
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}
module.exports = { checkPdfInteroperability };
