'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('../utils/fileSecurity');

const JOURNAL_VERSION = 1;
const JOURNAL_DIRECTORY_NAME = '_commit_journal';

class AuditFileCommitError extends Error {
  constructor(code) {
    super('Audit file version commit failed');
    this.name = 'AuditFileCommitError';
    this.code = code;
  }
}

function fail(code) {
  throw new AuditFileCommitError(code);
}

function isInsideRoot(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function ensureSecureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(directoryPath, 0o700);
}

function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Windows 不支持对目录句柄执行 fsync；Linux 生产环境仍会完成目录持久化。
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EBADF', 'EISDIR'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function writeDurableFile(filePath, buffer, exclusive) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, exclusive ? 'wx' : 'w', 0o600);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

function writeJsonAtomically(filePath, payload) {
  const tempPath = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const directoryPath = path.dirname(filePath);
  try {
    writeDurableFile(tempPath, Buffer.from(JSON.stringify(payload), 'utf8'), true);
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(directoryPath);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

function removeFileIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

function buildTargetPath(oldPath, operationId, index) {
  const directoryPath = path.dirname(oldPath);
  const extension = path.extname(oldPath);
  // 每步独立版本名长度恒定，禁止把上一版 commit 后缀不断累加到文件名。
  return path.join(directoryPath, 'file.commit-' + operationId + '-' + index + extension);
}

function normalizeEntries(entries, rootDir, operationId) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const oldPath = path.resolve(String(entry && entry.oldPath || ''));
    if (!isInsideRoot(rootDir, oldPath)) fail('AUDIT_FILE_COMMIT_PATH_OUTSIDE_ROOT');
    if (!Buffer.isBuffer(entry.buffer) || !entry.buffer.length) fail('AUDIT_FILE_COMMIT_BUFFER_INVALID');
    const fileId = String(entry.fileId || '').trim();
    const orgId = String(entry.orgId || '').trim();
    if (!fileId || !orgId) fail('AUDIT_FILE_COMMIT_SCOPE_REQUIRED');
    const targetPath = buildTargetPath(oldPath, operationId, index + 1);
    const stagedPath = targetPath + '.stage';
    if (!isInsideRoot(rootDir, targetPath) || !isInsideRoot(rootDir, stagedPath)) {
      fail('AUDIT_FILE_COMMIT_PATH_OUTSIDE_ROOT');
    }
    return {
      fileId,
      orgId,
      oldPath,
      targetPath,
      stagedPath,
      mimeType: String(entry.mimeType || ''),
      fileSize: entry.buffer.length,
      fileHash: String(entry.fileHash || ''),
      buffer: entry.buffer
    };
  });
}

function createAuditFileCommit(entries, options) {
  const config = options || {};
  const rootDir = path.resolve(config.uploadDir || UPLOAD_DIR);
  const operationId = String(config.operationId || crypto.randomBytes(20).toString('hex'));
  const journalDir = path.join(rootDir, JOURNAL_DIRECTORY_NAME);
  const journalPath = path.join(journalDir, operationId + '.json');
  const normalizedEntries = normalizeEntries(entries, rootDir, operationId);
  if (!normalizedEntries.length) {
    return {
      operationId,
      journalPath,
      entries: [],
      stage() {},
      metadataFor() { return null; },
      finalize() {},
      rollback() {}
    };
  }
  let staged = false;

  function journalPayload() {
    return {
      version: JOURNAL_VERSION,
      operationId,
      createdAt: new Date().toISOString(),
      files: normalizedEntries.map((entry) => ({
        fileId: entry.fileId,
        orgId: entry.orgId,
        oldPath: entry.oldPath,
        targetPath: entry.targetPath,
        stagedPath: entry.stagedPath,
        mimeType: entry.mimeType,
        fileSize: entry.fileSize,
        fileHash: entry.fileHash
      }))
    };
  }

  function stage() {
    ensureSecureDirectory(rootDir);
    ensureSecureDirectory(journalDir);
    writeJsonAtomically(journalPath, journalPayload());
    for (const entry of normalizedEntries) {
      writeDurableFile(entry.stagedPath, entry.buffer, true);
      fs.renameSync(entry.stagedPath, entry.targetPath);
      fsyncDirectory(path.dirname(entry.targetPath));
    }
    staged = true;
  }

  function metadataFor(fileId) {
    const entry = normalizedEntries.find((item) => item.fileId === String(fileId || ''));
    if (!entry) return null;
    return {
      filePath: entry.targetPath,
      mimeType: entry.mimeType,
      fileSize: entry.fileSize,
      fileHash: entry.fileHash
    };
  }

  function finalize() {
    if (!staged) return;
    normalizedEntries.forEach((entry) => { removeFileIfPresent(entry.stagedPath); });
    if (!removeFileIfPresent(journalPath)) return;
    try { fsyncDirectory(journalDir); } catch (_) {}
  }

  function rollback() {
    normalizedEntries.forEach((entry) => {
      removeFileIfPresent(entry.stagedPath);
      removeFileIfPresent(entry.targetPath);
    });
    const cleaned = removeFileIfPresent(journalPath);
    if (cleaned) {
      try { fsyncDirectory(journalDir); } catch (_) {}
    }
  }

  return { operationId, journalPath, entries: normalizedEntries, stage, metadataFor, finalize, rollback };
}

async function hasFileReference(database, filePath, orgId) {
  const [rows] = await database.query(
    'SELECT id FROM audit_submission_files WHERE file_path = ? AND org_id = ? LIMIT 1',
    [filePath, String(orgId || '')]
  );
  return rows.length > 0;
}

async function recoverPendingAuditFileCommits(options) {
  const config = options || {};
  const database = config.database;
  if (!database) fail('AUDIT_FILE_COMMIT_DATABASE_REQUIRED');
  const rootDir = path.resolve(config.uploadDir || UPLOAD_DIR);
  const journalDir = path.join(rootDir, JOURNAL_DIRECTORY_NAME);
  const report = { scanned: 0, committedRecovered: 0, rolledBackRecovered: 0, ambiguous: 0, invalid: 0 };
  if (!fs.existsSync(journalDir)) return report;
  const names = fs.readdirSync(journalDir).filter((name) => name.endsWith('.json')).sort();
  for (const name of names) {
    report.scanned += 1;
    const journalPath = path.join(journalDir, name);
    let journal;
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (Number(journal.version) !== JOURNAL_VERSION || !Array.isArray(journal.files) || !journal.files.length) {
        fail('AUDIT_FILE_COMMIT_JOURNAL_INVALID');
      }
      journal.files.forEach((entry) => {
        if (!String(entry.fileId || '').trim()
          || !String(entry.orgId || '').trim()
          || !isInsideRoot(rootDir, path.resolve(entry.oldPath))
          || !isInsideRoot(rootDir, path.resolve(entry.targetPath))
          || !isInsideRoot(rootDir, path.resolve(entry.stagedPath))) {
          fail('AUDIT_FILE_COMMIT_JOURNAL_SCOPE_INVALID');
        }
      });
    } catch (_) {
      report.invalid += 1;
      continue;
    }

    const states = [];
    for (const entry of journal.files) {
      const [rows] = await database.query(
        'SELECT file_path FROM audit_submission_files WHERE id = ? AND org_id = ? LIMIT 1',
        [String(entry.fileId || ''), String(entry.orgId || '')]
      );
      const currentPath = rows[0] && rows[0].file_path ? path.resolve(rows[0].file_path) : '';
      const oldPath = path.resolve(entry.oldPath);
      const targetPath = path.resolve(entry.targetPath);
      states.push(currentPath === targetPath ? 'target' : (currentPath === oldPath || !currentPath ? 'old' : 'ambiguous'));
    }

    if (states.every((state) => state === 'target')) {
      journal.files.forEach((entry) => { removeFileIfPresent(path.resolve(entry.stagedPath)); });
      removeFileIfPresent(journalPath);
      report.committedRecovered += 1;
      continue;
    }
    if (states.every((state) => state === 'old')) {
      for (const entry of journal.files) {
        const targetPath = path.resolve(entry.targetPath);
        removeFileIfPresent(path.resolve(entry.stagedPath));
        if (!(await hasFileReference(database, targetPath, entry.orgId))) removeFileIfPresent(targetPath);
      }
      removeFileIfPresent(journalPath);
      report.rolledBackRecovered += 1;
      continue;
    }
    report.ambiguous += 1;
  }
  return report;
}

module.exports = {
  JOURNAL_VERSION,
  JOURNAL_DIRECTORY_NAME,
  AuditFileCommitError,
  createAuditFileCommit,
  recoverPendingAuditFileCommits,
  isInsideRoot
};
