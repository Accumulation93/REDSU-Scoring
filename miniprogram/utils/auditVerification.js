const verificationCopy = require('../locales/zh-CN/auditVerification');

function presentVerificationResponse(response) {
  const result = response || {};
  const selectedSubmissionId = String(result.submissionId || '');
  const matches = (Array.isArray(result.matches) ? result.matches : []).map((item) => {
    const status = String(item.status || '');
    const statusClass = status === 'approved'
      ? 'verification-match-status--success'
      : status === 'rejected'
        ? 'verification-match-status--danger'
        : status === 'in_progress'
          ? 'verification-match-status--warning'
          : 'verification-match-status--muted';
    return Object.assign({}, item, {
      titleText: String(item.title || '') || verificationCopy.text.untitledSubmission,
      statusText: verificationCopy.text.status[status] || verificationCopy.text.unknownStatus,
      statusClass,
      isSelected: String(item.submissionId || '') === selectedSubmissionId,
      matchingFiles: Array.isArray(item.matchingFiles) ? item.matchingFiles : []
    });
  });
  return Object.assign({}, result, {
    // 字符串跨原生组件边界，避免开发者工具/旧运行时把嵌套数组转换为普通对象。
    componentResultJson: JSON.stringify({ verificationVersion: result.verificationVersion,
      verificationSource: result.verificationSource, verificationScope: result.verificationScope,
      overallStatus: result.overallStatus, files: result.files }),
    matches,
    matchCount: matches.length,
    matchCountText: verificationCopy.format.matchCount(matches.length)
  });
}

function buildMatchVerificationParams(result, submissionId, fileBase64) {
  const fileHash = String(result && result.verifyByFileHash || '');
  const selectedSubmissionId = String(submissionId || '');
  if (!fileHash || !selectedSubmissionId) return null;
  const params = { fileHash, submissionId: selectedSubmissionId };
  if (fileBase64) params.fileBase64 = fileBase64;
  return params;
}

module.exports = { verificationCopy, presentVerificationResponse, buildMatchVerificationParams };
