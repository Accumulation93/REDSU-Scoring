'use strict';

// 只读预检，不生成密钥，不打印路径、密钥、身份明文或密文。
const { assertSigningReadiness } = require('../src/modules/audit/services/signingEvidenceKeys');
try {
  const report = assertSigningReadiness();
  process.stdout.write(JSON.stringify({ status: 'ready', ...report }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'blocked', reasonCode: /^evidence_[a-z_]+$/.test(error.code || '')
    ? error.code : 'evidence_key_configuration_missing' }) + '\n');
  process.exitCode = 1;
}
