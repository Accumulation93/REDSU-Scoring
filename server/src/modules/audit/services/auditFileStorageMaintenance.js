'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../../../config/db');
const { logger } = require('../../../utils/logger');
const { UPLOAD_DIR } = require('../utils/fileSecurity');
const { recoverPendingAuditFileCommits } = require('./auditFileCommitCoordinator');
const signingEvidence = require('../models/signingEvidence');

const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ATTACHMENT_EXTENSION = /\.(?:png|jpe?g|webp|pdf)$/i;

function boundedDuration(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function isInsideRoot(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function safeChmod(targetPath, mode, report) {
  try {
    fs.chmodSync(targetPath, mode);
    report.permissionsSecured += 1;
  } catch (_) {
    report.permissionErrors += 1;
  }
}

function secureTree(rootDir, report) {
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const stack = [rootDir];
  while (stack.length) {
    const currentPath = stack.pop();
    let stat;
    try { stat = fs.lstatSync(currentPath); } catch (_) { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      safeChmod(currentPath, 0o700, report);
      let entries = [];
      try { entries = fs.readdirSync(currentPath); } catch (_) { continue; }
      entries.forEach((entry) => stack.push(path.join(currentPath, entry)));
    } else if (stat.isFile()) {
      safeChmod(currentPath, 0o600, report);
    }
  }
}

function collectAttachmentCandidates(rootDir) {
  const temporary = [];
  const permanent = [];
  if (!fs.existsSync(rootDir)) return { temporary, permanent };
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    const directoryPath = path.join(rootDir, entry.name);
    if (entry.name === '_tmp') {
      fs.readdirSync(directoryPath, { withFileTypes: true }).forEach((fileEntry) => {
        if (fileEntry.isFile() && ATTACHMENT_EXTENSION.test(fileEntry.name)) {
          temporary.push(path.join(directoryPath, fileEntry.name));
        }
      });
      return;
    }
    if (entry.name.startsWith('_')) return;
    fs.readdirSync(directoryPath, { withFileTypes: true }).forEach((fileEntry) => {
      if (fileEntry.isFile() && ATTACHMENT_EXTENSION.test(fileEntry.name)) {
        permanent.push(path.join(directoryPath, fileEntry.name));
      }
    });
  });
  return { temporary, permanent };
}

function normalizedReferencedPaths(rows) {
  const paths = new Set();
  const basenames = new Set();
  (rows || []).forEach((row) => {
    const filePath = String(row && row.file_path || '').trim();
    if (!filePath) return;
    paths.add(path.resolve(filePath));
    basenames.add(path.basename(filePath.replace(/\\/g, '/')));
  });
  return { paths, basenames };
}

async function hasDatabaseReference(database, filePath) {
  const [rows] = await database.query(
    `SELECT id
       FROM audit_submission_files
      WHERE file_path = ?
      LIMIT 1`,
    [filePath]
  );
  return rows.length > 0;
}

function createAuditFileStorageMaintenance(options) {
  const config = options || {};
  const database = config.database || pool;
  const rootDir = path.resolve(config.uploadDir || UPLOAD_DIR);
  const serviceLogger = config.logger || logger;
  const orphanGraceMs = boundedDuration(
    config.orphanGraceMs || process.env.AUDIT_ORPHAN_GRACE_MS,
    DEFAULT_ORPHAN_GRACE_MS,
    60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000
  );
  const intervalMs = boundedDuration(
    config.intervalMs || process.env.AUDIT_STORAGE_MAINTENANCE_INTERVAL_MS,
    DEFAULT_MAINTENANCE_INTERVAL_MS,
    60 * 1000,
    24 * 60 * 60 * 1000
  );
  let timer = null;
  let runningPromise = null;

  function securePermissions() {
    const report = { permissionsSecured: 0, permissionErrors: 0 };
    secureTree(rootDir, report);
    if (report.permissionErrors > 0) {
      const error = new Error('audit_storage_permission_hardening_failed');
      error.code = 'AUDIT_STORAGE_PERMISSION_HARDENING_FAILED';
      error.permissionErrors = report.permissionErrors;
      throw error;
    }
    return report;
  }

  async function deleteUnreferencedCandidate(filePath, referenced, cutoff, report, kind) {
    const resolvedPath = path.resolve(filePath);
    if (!isInsideRoot(rootDir, resolvedPath)
      || referenced.paths.has(resolvedPath)
      || referenced.basenames.has(path.basename(resolvedPath))) {
      report.referencedFilesPreserved += 1;
      return;
    }
    let stat;
    try { stat = fs.lstatSync(resolvedPath); } catch (_) { return; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) return;

    // 删除前再次向数据库逐文件确认，避免扫描期间新增引用造成误删。
    if (await hasDatabaseReference(database, resolvedPath)
      || (await signingEvidence.protectedPaths([resolvedPath], database)).length) {
      report.referencedFilesPreserved += 1;
      return;
    }
    try {
      fs.unlinkSync(resolvedPath);
      if (kind === 'temporary') report.temporaryOrphansRemoved += 1;
      else report.permanentOrphansRemoved += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') report.deletionErrors += 1;
    }
  }

  async function executeRun(nowValue) {
    const now = Number.isFinite(Number(nowValue)) ? Number(nowValue) : Date.now();
    const cutoff = now - orphanGraceMs;
    const report = {
      permissionsSecured: 0,
      permissionErrors: 0,
      temporaryOrphansRemoved: 0,
      permanentOrphansRemoved: 0,
      expiredReservationsRemoved: 0,
      referencedFilesPreserved: 0,
      missingReferencedFiles: 0,
      deletionErrors: 0,
      commitJournalsScanned: 0,
      commitJournalsRecovered: 0,
      commitJournalsAmbiguous: 0,
      commitJournalsInvalid: 0
    };
    const permissionReport = securePermissions();
    report.permissionsSecured = permissionReport.permissionsSecured;
    const recovery = await recoverPendingAuditFileCommits({ database, uploadDir: rootDir });
    report.commitJournalsScanned = recovery.scanned;
    report.commitJournalsRecovered = recovery.committedRecovered + recovery.rolledBackRecovered;
    report.commitJournalsAmbiguous = recovery.ambiguous;
    report.commitJournalsInvalid = recovery.invalid;

    const [[referenceRows], [activeTempRows]] = await Promise.all([
      database.query(
        `SELECT file_path
           FROM audit_submission_files
          WHERE file_path IS NOT NULL AND file_path <> ''`
      ),
      database.query(
        `SELECT temp_name
           FROM audit_temp_uploads
          WHERE expires_at > UTC_TIMESTAMP(3)`
      )
    ]);
    const referenced = normalizedReferencedPaths(referenceRows);
    const activeTempNames = new Set(activeTempRows.map((row) => path.basename(String(row.temp_name || ''))));
    referenced.paths.forEach((filePath) => {
      if (isInsideRoot(rootDir, filePath) && !fs.existsSync(filePath)) report.missingReferencedFiles += 1;
    });

    const candidates = collectAttachmentCandidates(rootDir);
    for (const filePath of candidates.temporary) {
      if (activeTempNames.has(path.basename(filePath))) continue;
      await deleteUnreferencedCandidate(filePath, referenced, cutoff, report, 'temporary');
    }
    for (const filePath of candidates.permanent) {
      await deleteUnreferencedCandidate(filePath, referenced, cutoff, report, 'permanent');
    }

    const [expiredResult] = await database.query(
      `DELETE FROM audit_temp_uploads
        WHERE expires_at <= UTC_TIMESTAMP(3)
        LIMIT 1000`
    );
    report.expiredReservationsRemoved = Number(expiredResult && expiredResult.affectedRows || 0);
    return report;
  }

  function runOnce(nowValue) {
    if (!runningPromise) {
      runningPromise = executeRun(nowValue).finally(() => { runningPromise = null; });
    }
    return runningPromise;
  }

  function runSafely() {
    runOnce().then((report) => {
      serviceLogger.info('Audit file storage maintenance complete', Object.assign({
        event: 'audit.storage.maintenance'
      }, report));
    }).catch((error) => {
      serviceLogger.error('Audit file storage maintenance failed', {
        event: 'audit.storage.maintenance.error',
        error: error.message
      });
    });
  }

  function start() {
    if (timer) return;
    runSafely();
    timer = setInterval(runSafely, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, securePermissions, rootDir, orphanGraceMs, intervalMs };
}

module.exports = Object.assign(createAuditFileStorageMaintenance(), {
  createAuditFileStorageMaintenance,
  isInsideRoot,
  secureTree,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_MAINTENANCE_INTERVAL_MS
});
