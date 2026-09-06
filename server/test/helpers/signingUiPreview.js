'use strict';

// 仅隔离数据库测试使用：真实上传字节进入生产验签服务，不预设密码验证结论。
const express = require('express');
const { decodeBase64, MAX_FILE_BYTES, sha256, equalHex } = require('../../src/modules/audit/utils/signingProtocol');

function serveSigningUiPreview({ port, originalBytes, verifyKnown, verifyUnknown }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
  const app = express();
  app.use(express.json({ limit: '14mb' }));
  let running = false;
  app.post('/verify', async (req, res) => {
    if (running) return res.status(429).json({ status: 'busy' });
    running = true;
    try {
      let result;
      if (Object.prototype.hasOwnProperty.call(req.body, 'fileBase64')) {
        const bytes = decodeBase64(req.body.fileBase64, MAX_FILE_BYTES);
        const digest = sha256(bytes);
        if (req.body.fileHash && !equalHex(req.body.fileHash, digest)) return res.json({ status: 'invalid_params' });
        result = equalHex(digest, sha256(originalBytes)) ? await verifyKnown(bytes) : await verifyUnknown(bytes);
      } else if (req.body.submissionNumber === 'CASE' || req.body.submissionId === 'case') {
        result = await verifyKnown();
      } else return res.json({ status: 'not_found' });
      return res.json({ status: 'success', ...result });
    } catch (_) {
      return res.status(400).json({ status: 'invalid_params' });
    } finally { running = false; }
  });
  // 不记录请求头、文件内容、身份或密钥；本服务只绑定回环地址并自动退出。
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => console.log('隔离验签现场服务已启动，端口 ' + port));
    const timer = setTimeout(() => server.close(resolve), 20 * 60 * 1000);
    timer.unref();
    server.once('error', error => { clearTimeout(timer); reject(error); });
    app.post('/finish', (_req, res) => {
      res.json({ status: 'success' });
      clearTimeout(timer);
      server.close(resolve);
    });
  });
}

module.exports = { serveSigningUiPreview };
