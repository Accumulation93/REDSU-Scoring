const localeCopy = require('../locales/zh-CN/generated/utils/trustedNavigation');
const TRUSTED_ROUTES = {
  '/subpackages/main/pages/login/login': true,
  '/subpackages/main/pages/portal/portal': true,
  '/subpackages/message/pages/messageCenter/messageCenter': true,
  '/subpackages/workspace/pages/home/home': true,
  '/subpackages/scoring/pages/score/score': true,
  '/subpackages/scoring/pages/admin/admin': true,
  '/subpackages/scoring/pages/scorerTasks/scorerTasks': true,
  '/subpackages/audit/pages/mySubmissions/mySubmissions': true,
  '/subpackages/audit/pages/submissionDetail/submissionDetail': true,
  '/subpackages/audit/pages/pendingApprovals/pendingApprovals': true,
  '/subpackages/audit/pages/myApprovalHistory/myApprovalHistory': true,
  '/subpackages/audit/pages/signatureManager/signatureManager': true,
  '/subpackages/audit/pages/verification/verification': true,
  '/subpackages/audit/pages/verificationReport/verificationReport': true,
  '/subpackages/venue/pages/venueManage/venueManage': true,
  '/subpackages/venue/pages/venueBookings/venueBookings': true,
  '/subpackages/venue/pages/venueBooking/venueBooking': true,
  '/subpackages/venue/pages/myVenueBookings/myVenueBookings': true,
  '/subpackages/venue/pages/pendingVenueApprovals/pendingVenueApprovals': true,
  '/subpackages/venue/pages/venueApprovalHistory/venueApprovalHistory': true,
  '/subpackages/venue/pages/venueApprovalHistoryDetail/venueApprovalHistoryDetail': true,
  '/subpackages/org/pages/switch/switch': true,
  '/subpackages/org/pages/adminPermissions/adminPermissions': true,
  '/subpackages/org/pages/identitySwitch/identitySwitch': true,
  '/subpackages/org/pages/accountSecurity/accountSecurity': true,
  '/subpackages/org/pages/authManagement/authManagement': true
};
const NAVIGATION_TIMEOUT_MS = 12000;

function isTrustedRoute(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || url.length > 1024 || /[\u0000-\u001f\\#]/.test(url)) return false;
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch (_) { return false; }
  if (decoded.indexOf('..') >= 0 || decoded.indexOf('\\') >= 0 || decoded.indexOf('://') >= 0) return false;
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  const query = queryIndex >= 0 ? url.slice(queryIndex + 1) : '';
  return TRUSTED_ROUTES[pathname] === true && (!query || /^[A-Za-z0-9_.~%=&+-]+$/.test(query));
}

function routePath(url) {
  return String(url || '').split('?')[0].replace(/^\//, '');
}

function isCurrentRoute(url) {
  if (typeof getCurrentPages !== 'function') return false;
  const pages = getCurrentPages();
  const current = pages && pages[pages.length - 1];
  return !!current && current.route === routePath(url);
}

function navigateToTrustedRoute(rawUrl, handlers) {
  const url = String(rawUrl || '').trim();
  const callbacks = handlers || {};
  if (!isTrustedRoute(url)) {
    wx.showToast({ title: localeCopy.copy_9aad91c741, icon: 'none' });
    return false;
  }
  let finished = false;
  let timer = null;
  const clearTimer = function() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  const finishSuccess = function(result) {
    if (finished) return;
    finished = true;
    clearTimer();
    if (typeof callbacks.success === 'function') callbacks.success(result);
  };
  const finishFailure = function(error) {
    if (finished) return;
    finished = true;
    clearTimer();
    if (typeof callbacks.fail === 'function') callbacks.fail(error);
    else wx.showToast({ title: localeCopy.copy_4becb061c6, icon: 'none' });
  };
  // 旧版鸿蒙运行时加载分包可能较慢。超时只解除调用方忙碌状态并提示，
  // 不再发起 redirectTo/reLaunch；多种导航同时竞争会中断原本仍在加载的分包。
  timer = setTimeout(function() {
    if (isCurrentRoute(url)) {
      finishSuccess({ errMsg: 'navigateTo:ok route active' });
      return;
    }
    finishFailure({ errMsg: 'navigateTo:fail timeout' });
  }, NAVIGATION_TIMEOUT_MS);
  if (typeof wx.navigateTo !== 'function') {
    finishFailure({ errMsg: 'navigateTo:fail unavailable' });
    return false;
  }
  wx.navigateTo({
    url: url,
    success: finishSuccess,
    fail: finishFailure
  });
  return true;
}

function reLaunchTrustedRoute(rawUrl, handlers) {
  const url = String(rawUrl || '').trim();
  const callbacks = handlers || {};
  if (!isTrustedRoute(url)) {
    wx.showToast({ title: localeCopy.copy_9aad91c741, icon: 'none' });
    return false;
  }
  if (typeof wx.reLaunch !== 'function') {
    if (typeof callbacks.fail === 'function') callbacks.fail({ errMsg: 'reLaunch:fail unavailable' });
    else wx.showToast({ title: localeCopy.copy_4becb061c6, icon: 'none' });
    return false;
  }
  wx.reLaunch({
    url,
    success: callbacks.success,
    fail: callbacks.fail || function() {
      wx.showToast({ title: localeCopy.copy_4becb061c6, icon: 'none' });
    }
  });
  return true;
}

function reLaunchPortalThenNavigate(rawUrl, handlers) {
  const targetUrl = String(rawUrl || '').trim();
  const callbacks = handlers || {};
  if (!isTrustedRoute(targetUrl)) {
    wx.showToast({ title: localeCopy.copy_9aad91c741, icon: 'none' });
    return false;
  }
  const portalUrl = '/subpackages/main/pages/portal/portal?next=' + encodeURIComponent(targetUrl);
  return reLaunchTrustedRoute(portalUrl, callbacks);
}

module.exports = {
  isTrustedRoute,
  navigateToTrustedRoute,
  reLaunchTrustedRoute,
  reLaunchPortalThenNavigate,
  isCurrentRoute
};
