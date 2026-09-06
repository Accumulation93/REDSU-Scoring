const orgSession = require('./orgSession');
const { navigateToTrustedRoute } = require('./trustedNavigation');
const copy = require('../locales/zh-CN/signingEvidence');
const SLOT = '__auditVerificationReport';

function open(result) {
  const app = getApp();
  if (!app.globalData) app.globalData = {};
  // 一次性内存交接，不放 URL 或本地持久化；切换账号、组织或岗位立即失效。
  app.globalData[SLOT] = { json: JSON.stringify(result), snapshot: orgSession.getSnapshot(), expires: Date.now() + 60000 };
  navigateToTrustedRoute('/subpackages/audit/pages/verificationReport/verificationReport', {
    fail: function() { delete app.globalData[SLOT]; wx.showToast({ title: copy.reportOpenFailed, icon: 'none' }); }
  });
}
function take() {
  const app = getApp();
  const value = app.globalData && app.globalData[SLOT];
  if (app.globalData) delete app.globalData[SLOT];
  if (!value || value.expires < Date.now() || !orgSession.isCurrent(value.snapshot)) return null;
  return value;
}
module.exports = { open, take };
