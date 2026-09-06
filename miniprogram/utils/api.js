const localeCopy = require('../locales/zh-CN/generated/utils/api');
const API_BASE = 'https://accumulation93.com/api';
const CLIENT_VERSION = '1.2.0-security';
const orgSession = require('./orgSession');
const dateTime = require('./dateTime');
const IDEMPOTENT_WRITE_APIS = {
  submitScoreRecord: true,
  startAuditSubmission: true,
  startAdHocAudit: true,
  createVenueBooking: true,
  createAdminVenueBooking: true,
  deleteHrMembershipPermanently: true,
  deletePersonPermanently: true
};
const AUTH_ENTRY_APIS = {
  getTimeConfig: true,
  'auth/wechat/session': true,
  'auth/claims': true,
  'auth/claims/verify': true,
  'auth/claims/redeem': true,
  'auth/password/session': true,
  'auth/recovery/start': true,
  'auth/recovery/complete': true
};

let authenticationRedirecting = false;
let contextActivationDepth = 0;

function createRequestId() {
  return 'mp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function createRequestHeaders(requestId) {
  const session = orgSession.getSnapshot();
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (session.token || ''),
    'X-Active-Org': session.orgId || '',
    'X-Role': session.role || '',
    'X-Client-Version': CLIENT_VERSION,
    'X-Request-Id': requestId || createRequestId()
  };
}

function cancelledError(requestId) {
  return {
    errMsg: 'request:fail request_cancelled',
    message: localeCopy.copy_e58fa637eb,
    status: 'request_cancelled',
    requestId: requestId,
    silent: true
  };
}

function notifyUpgrade(result) {
  if (!result || result.status !== 'client_upgrade_required') return;
  try {
    const app = getApp();
    if (app && app.notifyUpgradeRequired) app.notifyUpgradeRequired(result.message);
  } catch (_) {}
}

function captureSystemTimezone(result) {
  if (!result || typeof result !== 'object') return;
  const config = result.config && typeof result.config === 'object' ? result.config : {};
  const offset = result.systemTimezoneOffset !== undefined
    ? result.systemTimezoneOffset
    : config.timezone;
  if (offset === undefined) return;
  dateTime.setSystemTimezoneConfig(
    offset,
    result.timezoneConfigVersion !== undefined
      ? result.timezoneConfigVersion
      : config.timezoneConfigVersion,
    result.historicalTimeReviewRequired !== undefined
      ? result.historicalTimeReviewRequired
      : config.historicalTimeReviewRequired,
    result.timeReviewConfigVersion !== undefined
      ? result.timeReviewConfigVersion
      : config.timeReviewConfigVersion
  );
}

function applyResponseSideEffects(result) {
  // 时区缓存、升级提示和岗位提示都不是请求成功的前置条件。部分鸿蒙基础库
  // 会在这些可选能力中抛出同步异常；必须隔离，不能让已收到的响应永久 pending。
  try { captureSystemTimezone(result); } catch (_) {}
  try { notifyUpgrade(result); } catch (_) {}
  try { notifyOrgContextRequired(result); } catch (_) {}
}

function scheduleResponseSideEffects(result) {
  // Promise 的续接要等当前 wx.request 回调返回后才会执行，因此不能只把
  // resolve 写在副作用之前；必须把副作用移到下一轮任务，先让登录继续。
  setTimeout(function() {
    applyResponseSideEffects(result);
  }, 0);
}

let orgPromptVisible = false;
function notifyOrgContextRequired(result) {
  if (!result || result.status !== 'org_context_required' || orgPromptVisible) return;
  orgPromptVisible = true;
  wx.showModal({
    title: localeCopy.copy_c6070950c1,
    content: result.message || localeCopy.copy_db7d9fed8e,
    showCancel: false,
    confirmText: localeCopy.copy_d869b80f50,
    complete: function() {
      orgPromptVisible = false;
      require('./trustedNavigation').navigateToTrustedRoute(
        '/subpackages/org/pages/identitySwitch/identitySwitch',
        { fail: function() { wx.reLaunch({ url: '/subpackages/main/pages/portal/portal' }); } }
      );
    }
  });
}

function createResponseError(res) {
  const responseData = res.data || {};
  return {
    errMsg: 'request:fail statusCode ' + res.statusCode,
    message: responseData.message || '',
    status: responseData.status || '',
    statusCode: res.statusCode,
    data: responseData,
    requestId: (res.header && (res.header['X-Request-Id'] || res.header['x-request-id'])) || ''
  };
}

function isAuthenticationFailure(statusCode, result) {
  if (Number(statusCode) !== 401) return false;
  const status = String((result && result.status) || '');
  return !status || [
    'auth_failed',
    'session_expired',
    'binding_missing',
    'account_unavailable'
  ].indexOf(status) >= 0;
}

function authenticationMessage(error) {
  const status = String((error && error.status) || '');
  if (status === 'account_frozen') return localeCopy.copy_d6a178f6ce;
  if (status === 'need_claim' || status === 'binding_missing') return localeCopy.copy_e7c4c49eab;
  return localeCopy.copy_c337bd9350;
}

function redirectToLogin(error) {
  if (authenticationRedirecting) return;
  authenticationRedirecting = true;
  const message = authenticationMessage(error);
  try {
    require('./authContext').clearUnifiedAuthentication();
  } catch (_) {
    orgSession.clearAuthentication('');
  }
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    if (app) {
      if (!app.globalData || typeof app.globalData !== 'object') app.globalData = {};
      app.globalData.__authLoginNotice = message;
    }
  } catch (_) {}
  try {
    if (typeof wx.setStorage === 'function') {
      wx.setStorage({ key: 'authLoginNotice', data: message });
    } else if (typeof wx.setStorageSync === 'function') {
      wx.setStorageSync('authLoginNotice', message);
    }
  } catch (_) {}
  wx.showToast({ title: message, icon: 'none', duration: 1800 });
  wx.reLaunch({ url: '/subpackages/main/pages/login/login?reason=expired' });
}

function markAuthenticationReady() {
  authenticationRedirecting = false;
}

function beginContextActivation() {
  contextActivationDepth += 1;
}

function endContextActivation() {
  contextActivationDepth = Math.max(0, contextActivationDepth - 1);
}

function hasSameSelection(left, right) {
  if (!left || !right) return false;
  return left.orgId === right.orgId
    && left.role === right.role
    && left.contextId === right.contextId
    && left.identityId === right.identityId;
}

function requestOnce(name, data, requestId, allowAuthenticationRefresh, timeoutMs) {
  // 登录、认领与恢复属于会话入口，此时客户端本就可能没有可比较的组织会话。
  // 真机收到响应后不得再执行一轮同步存储读取，否则部分 OpenHarmony 设备会
  // 卡在请求已返回、Promise 尚未完成的状态。
  const isAuthEntry = Boolean(AUTH_ENTRY_APIS[name]);
  const organizationSnapshot = isAuthEntry ? null : orgSession.getSnapshot();
  return new Promise(function(resolve, reject) {
    wx.request({
      url: API_BASE + '/' + name,
      method: 'POST',
      timeout: Math.max(1000, Number(timeoutMs) || 15000),
      header: createRequestHeaders(requestId),
      data: data,
      success: function(res) {
        if (!isAuthEntry && !orgSession.isCurrent(organizationSnapshot)) {
          const currentSnapshot = orgSession.getSnapshot();
          if (allowAuthenticationRefresh
            && hasSameSelection(organizationSnapshot, currentSnapshot)
            && currentSnapshot.token
            && currentSnapshot.token !== organizationSnapshot.token) {
            requestOnce(name, data, requestId, false, timeoutMs).then(resolve, reject);
            return;
          }
          reject(cancelledError(requestId));
          return;
        }
        if (res.statusCode === 200) {
          resolve(res.data);
          scheduleResponseSideEffects(res.data);
          return;
        }
        const responseData = res.data || {};
        applyResponseSideEffects(responseData);
        const responseError = createResponseError(res);
        if (responseData.status === 'org_context_required') responseError.silent = true;
        if (contextActivationDepth > 0
          && name !== 'auth/contexts/activate'
          && isAuthenticationFailure(res.statusCode, responseData)) {
          reject(cancelledError(requestId));
          return;
        }
        if (allowAuthenticationRefresh
          && !AUTH_ENTRY_APIS[name]
          && isAuthenticationFailure(res.statusCode, responseData)) {
          // 失效会话不能证明当前账号。禁止自动调用微信登录，更不能在另一个账号下重放。
          redirectToLogin(responseError);
          responseError.silent = true;
          reject(responseError);
          return;
        }
        reject(responseError);
      },
      fail: function(err) {
        if (!isAuthEntry && !orgSession.isCurrent(organizationSnapshot)) {
          reject(cancelledError(requestId));
          return;
        }
        console.error('[API] Request failed:', name, JSON.stringify(err));
        const requestError = err || { errMsg: 'request:fail unknown' };
        if (/timeout/i.test(requestError.errMsg || '')) requestError.timedOut = true;
        reject(requestError);
      }
    });
  });
}

function callFunction(options) {
  const name = options.name || '';
  const data = Object.assign({}, options.data || {});
  const success = options.success;
  const fail = options.fail;
  const complete = options.complete;

  if (!/^[A-Za-z][A-Za-z0-9_\/-]*$/.test(name)) {
    const invalidNameError = { errMsg: 'request:fail invalid api name' };
    if (fail) fail(invalidNameError);
    if (complete) complete();
    const rejected = Promise.reject(invalidNameError);
    if (success || fail || complete) rejected.catch(function() {});
    return rejected;
  }

  const requestId = createRequestId();
  if (IDEMPOTENT_WRITE_APIS[name] && !data.clientRequestId) data.clientRequestId = requestId;
  const promise = requestOnce(name, data, requestId, true, options.timeout);

  // Backward compatibility: wire up callbacks if provided
  if (success || fail || complete) {
    promise.then(
      function(result) {
        if (success) success({ result: result });
        if (complete) complete();
      },
      function(err) {
        if (fail && !(err && err.silent)) fail(err);
        if (complete) complete();
      }
    );
  }

  return promise;
}

function showShortToast(title, icon) {
  if (!icon) icon = 'none';
  const t = String(title || '');
  if (!t) return;
  wx.showToast({ title: t, icon: icon });
}

function getErrorText(error, fallback) {
  if (error && (error.silent || error.status === 'request_cancelled')) return '';
  const text = String((error && error.message) || '').trim();
  return text || fallback;
}

/**
 * Format an audit timestamp for display.
 * Handles both ISO 8601 (2026-06-12T08:30:00.000Z) and MySQL DATETIME (2026-06-12 16:30:00).
 * Output: "2026-06-12 16:30" in local time
 */
function formatAuditTime(raw, reviewStatus) {
  return dateTime.formatListTime(raw, { reviewStatus: reviewStatus });
}

function formatAuditDetailTime(raw, reviewStatus) {
  return dateTime.formatDetailTime(raw, { reviewStatus: reviewStatus });
}

module.exports = {
  API_BASE: API_BASE,
  CLIENT_VERSION: CLIENT_VERSION,
  callFunction: callFunction,
  createRequestId: createRequestId,
  createRequestHeaders: createRequestHeaders,
  markAuthenticationReady: markAuthenticationReady,
  beginContextActivation: beginContextActivation,
  endContextActivation: endContextActivation,
  showShortToast: showShortToast,
  getErrorText: getErrorText,
  isRequestCancelled: function(error) { return !!(error && (error.silent || error.status === 'request_cancelled')); },
  formatAuditTime: formatAuditTime,
  formatAuditDetailTime: formatAuditDetailTime
};
