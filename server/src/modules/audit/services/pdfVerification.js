'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { MAX_FILE_BYTES } = require('../utils/signingProtocol');
let activeWorkers = 0;
function unavailable(reasonCode) { return { present: false, valid: false, signatures: [], reasonCode }; }
function verifyPdfBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) return Promise.resolve(unavailable('pdf_size_invalid'));
  if (activeWorkers >= 2) return Promise.resolve(unavailable('verification_busy'));
  activeWorkers += 1;
  return new Promise(resolve => {
    let worker;
    let timer;
    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      activeWorkers -= 1;
      if (worker) worker.terminate().catch(() => {});
      resolve(result);
    }
    try {
      worker = new Worker(path.join(__dirname, 'pdfVerificationWorker.js'), { workerData: bytes,
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
      timer = setTimeout(() => finish(unavailable('verification_timeout')), 5000);
      worker.once('message', finish);
      worker.once('error', () => finish(unavailable('verification_parser_unavailable')));
      worker.once('exit', () => finish(unavailable('verification_parser_unavailable')));
    } catch (_) { finish(unavailable('verification_parser_unavailable')); }
  });
}
module.exports = { verifyPdfBytes };
