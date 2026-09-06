const localeCopy = require('../../../locales/zh-CN/generated/modules/audit/routes/auditFile');
const retiredCopy = require('../../../locales/zh-CN/generated/core/routes/admin');
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { safeString, generateId } = require('../../../utils/helpers');
const {
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  assertAllowedFile,
  createTempUpload,
  getAuthorizedAuditFile,
  ensurePrivateDirectory,
  ensurePrivateFile,
  readStoredAuditFile
} = require('../utils/fileSecurity');

const execFileAsync = promisify(execFile);
const MAX_PDF_PAGES = 100;
const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;
const MAX_PDF_RENDER_CONCURRENCY = 2;
let activePdfRenders = 0;
const pdfRenderQueue = [];

ensurePrivateDirectory(UPLOAD_DIR);

async function getPdfPageCount(filePath) {
  const { PDFDocument } = require('pdf-lib');
  const pdfDoc = await PDFDocument.load(fs.readFileSync(filePath));
  return pdfDoc.getPageCount() || 1;
}

async function assertSafeFileContent(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    const { PDFDocument } = require('pdf-lib');
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false });
    if (pdf.getPageCount() > MAX_PDF_PAGES) {
      const error = new Error(localeCopy.copy_e21f279212);
      error.status = 'invalid_params';
      throw error;
    }
    return;
  }
  const metadata = await require('sharp')(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  const pixels = Number(metadata.width || 0) * Number(metadata.height || 0);
  if (!pixels || pixels > MAX_IMAGE_PIXELS) {
    const error = new Error(localeCopy.copy_321d99b760);
    error.status = 'invalid_params';
    throw error;
  }
}

function runWithPdfRenderSlot(task, signal) {
  return new Promise((resolve, reject) => {
    const entry = { task, resolve, reject, signal };
    const runNext = () => {
      while (activePdfRenders < MAX_PDF_RENDER_CONCURRENCY && pdfRenderQueue.length) {
        const next = pdfRenderQueue.shift();
        if (next.signal && next.signal.aborted) {
          next.reject(new Error('request_cancelled'));
          continue;
        }
        activePdfRenders += 1;
        Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => {
          activePdfRenders -= 1;
          runNext();
        });
      }
    };
    pdfRenderQueue.push(entry);
    runNext();
  });
}

async function renderPdfPageWithPdftoppm(filePath, page) {
  const prefix = path.join(os.tmpdir(), 'audit_pdf_preview_' + generateId());
  const exe = process.env.PDFTOPPM_PATH || 'pdftoppm';
  await execFileAsync(exe, [
    '-f', String(page),
    '-l', String(page),
    '-png',
    '-singlefile',
    '-r', '150',
    filePath,
    prefix
  ], { windowsHide: true, timeout: 30000 });

  const outPath = prefix + '.png';
  const buffer = fs.readFileSync(outPath);
  try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
  return buffer;
}

async function renderPdfPageWithPdfjs(filePath, page) {
  const { createCanvas, DOMMatrix, Path2D, ImageData } = require('@napi-rs/canvas');
  global.DOMMatrix = global.DOMMatrix || DOMMatrix;
  global.Path2D = global.Path2D || Path2D;
  global.ImageData = global.ImageData || ImageData;
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const canvasFactory = {
    create(width, height) {
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },
    destroy(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  };
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    canvasFactory
  });
  const pdfDoc = await loadingTask.promise;
  const pdfPage = await pdfDoc.getPage(page);
  const viewport = pdfPage.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const canvasContext = canvas.getContext('2d');
  await pdfPage.render({ canvasContext, viewport, canvasFactory }).promise;
  const pngBuffer = canvas.toBuffer('image/png');
  await pdfDoc.destroy();
  return pngBuffer;
}

async function renderPdfPageUnqueued(filePath, page) {
  const errors = [];
  try {
    const sharp = require('sharp');
    const buffer = await sharp(filePath, { page: page - 1, density: 150 }).png().toBuffer();
    return { buffer, renderer: 'sharp' };
  } catch (sharpErr) {
    errors.push('sharp: ' + sharpErr.message);
  }

  try {
    const buffer = await renderPdfPageWithPdfjs(filePath, page);
    return { buffer, renderer: 'pdfjs' };
  } catch (pdfjsErr) {
    errors.push('pdfjs: ' + pdfjsErr.message);
  }

  try {
    const buffer = await renderPdfPageWithPdftoppm(filePath, page);
    return { buffer, renderer: 'pdftoppm' };
  } catch (pdftoppmErr) {
    errors.push('pdftoppm: ' + pdftoppmErr.message);
  }

  const err = new Error('PDF preview render failed: ' + errors.join('; '));
  err.renderErrors = errors;
  throw err;
}

function renderPdfPage(filePath, page, signal) {
  return runWithPdfRenderSlot(() => renderPdfPageUnqueued(filePath, page), signal);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

router.post('/uploadAuditFile', function(req, res, next) {
  const contentType = req.get('content-type') || '';
  if (contentType.indexOf('multipart/form-data') !== -1) {
    return upload.single('file')(req, res, function(error) {
      if (!error) return next();
      console.error('[audit:file:multipart] failed:', error);
      return res.json({
        status: 'invalid_params',
        message: error.code === 'LIMIT_FILE_SIZE'
          ? localeCopy.copy_9288d54fa0
          : localeCopy.operationFailed
      });
    });
  }
  next();
}, async (req, res) => {
  try {
    let fileName = '';
    let mimeType = '';
    let buffer = null;

    if (req.file) {
      fileName = safeString(req.file.originalname);
      mimeType = safeString(req.file.mimetype);
      buffer = req.file.buffer;
    } else if (req.body.fileBase64) {
      fileName = safeString(req.body.fileName);
      mimeType = safeString(req.body.mimeType);
      if (String(req.body.fileBase64).length > Math.ceil(MAX_FILE_SIZE * 4 / 3) + 1024) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_9288d54fa0 });
      }
      buffer = Buffer.from(String(req.body.fileBase64), 'base64');
    } else {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_37b735afaf });
    }

    mimeType = assertAllowedFile(buffer, mimeType);
    await assertSafeFileContent(buffer, mimeType);
    const uploadInfo = await createTempUpload({
      buffer,
      fileName,
      mimeType,
      accountId: req.authAccount && req.authAccount.id
    });

    res.json({ status: 'success', ...uploadInfo });
  } catch (e) {
    console.error('[audit:file:upload] failed:', e);
    res.json({
      status: e.status || 'error',
      message: e.status ? safeString(e.message) : localeCopy.operationFailed
    });
  }
});

router.post('/getAuditFile', async (req, res) => {
  try {
    const fileId = safeString(req.body.fileId);
    if (!fileId) return res.json({ status: 'invalid_params', message: localeCopy.copy_03d69a9d28 });

    const auth = await getAuthorizedAuditFile(fileId, req);
    if (auth.status !== 'success') return res.json(auth);
    const file = auth.file;

    const stored = readStoredAuditFile(file);
    if (stored.status !== 'success') return res.json(stored);
    const buffer = stored.buffer;
    res.json({
      status: 'success',
      fileName: file.file_name,
      mimeType: file.mime_type,
      fileSize: file.file_size,
      fileHash: file.file_hash,
      data: buffer.toString('base64')
    });
  } catch (e) {
    console.error('[audit:file:read] failed:', e);
    res.json({ status: 'error', message: localeCopy.operationFailed });
  }
});

// Direct binary download — avoids base64 overhead and USER_DATA_PATH quota issues.
// Used by wx.downloadFile → wx.openDocument for reliable file opening.
router.get('/downloadAuditFile', async (req, res) => {
  try {
    const fileId = safeString(req.query.fileId);
    if (!fileId) return res.status(400).json({ status: 'invalid_params', message: localeCopy.copy_03d69a9d28 });

    const auth = await getAuthorizedAuditFile(fileId, req);
    if (auth.status !== 'success') {
      const code = auth.status === 'forbidden' ? 403 : 404;
      return res.status(code).json(auth);
    }
    const file = auth.file;

    const stored = readStoredAuditFile(file);
    if (stored.status !== 'success') {
      return res.status(stored.status === 'integrity_error' ? 409 : 404).json(stored);
    }

    const mime = file.mime_type || 'application/octet-stream';
    const encodedName = encodeURIComponent(file.file_name);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Length', String(stored.buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(stored.buffer);
  } catch (e) {
    console.error('[audit:file:download] failed:', e);
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: localeCopy.operationFailed });
    }
  }
});

router.post('/getAuditFilePreview', async (req, res) => {
  try {
    const fileId = safeString(req.body.fileId);
    const page = parseInt(req.body.page) || 1;
    if (!fileId) return res.json({ status: 'invalid_params', message: localeCopy.copy_03d69a9d28 });

    const auth = await getAuthorizedAuditFile(fileId, req);
    if (auth.status !== 'success') return res.json(auth);
    const file = auth.file;

    const stored = readStoredAuditFile(file);
    if (stored.status !== 'success') return res.json(stored);

    const mimeType = file.mime_type;
    if (mimeType && mimeType.startsWith('image/')) {
      return res.json({
        status: 'success',
        fileName: file.file_name,
        mimeType,
        previewMime: mimeType,
        totalPages: 1,
        page: 1,
        data: stored.buffer.toString('base64')
      });
    }

    if (mimeType === 'application/pdf') {
      const previewDirectory = path.join(UPLOAD_DIR, '_tmp');
      ensurePrivateDirectory(previewDirectory);
      const verifiedPreviewPath = path.join(previewDirectory, 'preview-' + generateId() + '.pdf');
      fs.writeFileSync(verifiedPreviewPath, stored.buffer, { mode: 0o600 });
      ensurePrivateFile(verifiedPreviewPath);
      let totalPages = 1;
      try {
        totalPages = await getPdfPageCount(verifiedPreviewPath);
        const targetPage = Math.max(1, Math.min(page, totalPages));
        const rendered = await renderPdfPage(verifiedPreviewPath, targetPage, req.signal);
        return res.json({
          status: 'success',
          fileName: file.file_name,
          mimeType: 'application/pdf',
          previewMime: 'image/png',
          totalPages,
          page: targetPage,
          data: rendered.buffer.toString('base64'),
          renderer: rendered.renderer
        });
      } catch (e) {
        return res.json({
          status: 'success',
          fileName: file.file_name,
          mimeType: 'application/pdf',
          previewMime: 'application/pdf',
          totalPages,
          page: page,
          data: null,
          fallback: true,
          message: localeCopy.copy_3f63b19ec7,
          requestId: req.requestId || ''
        });
      } finally {
        try { fs.unlinkSync(verifiedPreviewPath); } catch (_) { /* 维护任务会清理意外残留的预览副本。 */ }
      }
    }

    res.json({
      status: 'success',
      fileName: file.file_name,
      mimeType,
      previewMime: mimeType,
      totalPages: 1,
      page: 1,
      data: null,
      fallback: true
    });
  } catch (e) {
    console.error('[audit:file:preview] failed:', e);
    res.json({ status: 'error', message: localeCopy.operationFailed });
  }
});

router.post('/mergeSignaturesIntoFile', (req, res) => {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
});

module.exports = router;
