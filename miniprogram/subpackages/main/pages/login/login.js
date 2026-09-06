const {
  API_BASE,
  CLIENT_VERSION,
  callFunction,
  createRequestId,
  showShortToast,
  getErrorText
} = require('../../../../utils/api');
const orgSession = require('../../../../utils/orgSession');
const authContext = require('../../../../utils/authContext');
const passwordBindingOffer = require('../../../../utils/passwordBindingOffer');
const { login: copy } = require('../../../../locales/zh-CN/main');
const { getPasswordRequiredMessage } = require('./loginValidation');

const WECHAT_LOGIN_TIMEOUT_MS = 10000;
const WECHAT_SESSION_TIMEOUT_MS = 18000;
const PORTAL_NAVIGATION_TIMEOUT_MS = 8000;
const LOGIN_PREFERENCE_WAIT_MS = 250;
const PORTAL_ROUTE = '/subpackages/main/pages/portal/portal';

function selectedOrganizationName(organizations, index) {
  const item = organizations[Number(index) || 0];
  return item ? item.name : '';
}

function requestWechatLoginCode() {
  return new Promise(function(resolve, reject) {
    let settled = false;
    const timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      reject(new Error(copy.messages.loginUnavailable));
    }, WECHAT_LOGIN_TIMEOUT_MS);
    const finish = function(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    wx.login({
      success(result) {
        if (result && result.code) finish(resolve, result.code);
        else finish(reject, new Error(copy.messages.relogin));
      },
      fail() {
        finish(reject, new Error(copy.messages.relogin));
      }
    });
  });
}

function readStorageValue(key) {
  return new Promise(function(resolve) {
    if (typeof wx.getStorage !== 'function') {
      try {
        resolve(typeof wx.getStorageSync === 'function' ? String(wx.getStorageSync(key) || '') : '');
      } catch (_) {
        resolve('');
      }
      return;
    }
    let settled = false;
    const timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      resolve('');
    }, LOGIN_PREFERENCE_WAIT_MS);
    try {
      wx.getStorage({
        key: key,
        success: function(result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result && result.data ? String(result.data) : '');
        },
        fail: function() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve('');
        }
      });
    } catch (_) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('');
    }
  });
}

function loadPreferredSelection() {
  return Promise.all([
    readStorageValue('lastContextId'),
    readStorageValue('lastOrganizationId')
  ]).then(function(values) {
    return {
      contextId: String(values[0] || ''),
      organizationId: String(values[1] || '')
    };
  });
}

function consumeRuntimeLoginNotice() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    const notice = app && app.globalData
      ? String(app.globalData.__authLoginNotice || '')
      : '';
    if (notice) delete app.globalData.__authLoginNotice;
    return notice;
  } catch (_) {
    return '';
  }
}

function requestWechatSessionDirect(callbacks, preferredSelection) {
  const handlers = callbacks || {};
  const preferred = preferredSelection || {};
  let settled = false;
  let requestTask = null;
  const startedAt = Date.now();
  const requestId = createRequestId();
  const trace = function(stage, extra) {
    // 只记录阶段、耗时和请求号，不记录微信 code、令牌、身份或响应内容。
    const entry = Object.assign({ stage, elapsedMs: Date.now() - startedAt, requestId }, extra || {});
    try { if (typeof handlers.trace === 'function') handlers.trace(entry); } catch (_) {}
  };
  const finish = function(type, value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      if (type === 'success') {
        if (typeof handlers.success === 'function') handlers.success(value);
      } else if (typeof handlers.fail === 'function') {
        handlers.fail(value);
      }
    } finally {
      if (typeof handlers.complete === 'function') handlers.complete();
    }
  };
  let timer = setTimeout(function() {
    trace('total_timeout');
    // 原生请求仍以自身 timeout 收尾，不在桥接 abort 前等待释放页面忙碌态。
    finish('fail', new Error(copy.messages.loginUnavailable));
  }, WECHAT_SESSION_TIMEOUT_MS);

  if (typeof wx.login !== 'function' || typeof wx.request !== 'function') {
    finish('fail', new Error(copy.messages.loginUnavailable));
    return;
  }
  try {
    trace('wechat_started');
    wx.login({
    success: function(loginResult) {
      if (settled) return;
      trace('wechat_returned');
      const code = String((loginResult && loginResult.code) || '');
      if (!code) {
        finish('fail', new Error(copy.messages.relogin));
        return;
      }
      try {
        trace('request_started');
        requestTask = wx.request({
          url: API_BASE + '/auth/wechat/session',
          method: 'POST',
          timeout: 15000,
          header: {
            'Content-Type': 'application/json',
            'X-Client-Version': CLIENT_VERSION,
            'X-Request-Id': requestId
          },
          data: {
            code: code,
            preferredContextId: preferred.contextId || '',
            preferredOrganizationId: preferred.organizationId || ''
          },
          success: function(response) {
            trace(settled ? 'late_response' : 'response_received', { httpStatus: Number(response && response.statusCode) || 0 });
            if (settled) return;
            let result = (response && response.data) || {};
            if (typeof result === 'string') {
              try { result = JSON.parse(result); } catch (_) { result = {}; }
            }
            if (Number(response && response.statusCode) === 200) {
              finish('success', result);
              return;
            }
            const error = new Error(result.message || copy.messages.loginUnavailable);
            error.status = result.status || '';
            finish('fail', error);
          },
          fail: function(error) {
            trace(settled ? 'late_failure' : 'request_failed', { nativeCode: Number(error && error.errno) || 0 });
            finish('fail', error || new Error(copy.messages.loginUnavailable));
          }
        });
        if (requestTask && typeof requestTask.onHeadersReceived === 'function') {
          try { requestTask.onHeadersReceived(function() { trace('headers_received'); }); } catch (_) {}
        }
      } catch (error) {
        finish('fail', error);
      }
    },
    fail: function(error) {
      trace('wechat_failed', { nativeCode: Number(error && error.errno) || 0 });
      finish('fail', error || new Error(copy.messages.relogin));
    }
    });
  } catch (error) {
    finish('fail', error);
  }
  return function cancel() {
    settled = true;
    clearTimeout(timer);
  };
}

Page({
  data: {
    copy: copy.view,
    loading: false,
    sheetClass: 'sheet',
    stage: 'login',
    organizations: [],
    organizationIndex: 0,
    organizationName: '',
    name: '',
    studentId: '',
    claimId: '',
    recoveryRequestId: '',
    verificationCode: '',
    recoveryMethod: 'recovery_code',
    recoveryMethodIndex: 0,
    recoveryMethodLabel: copy.messages.recoveryCode,
    recoveryMethods: [],
    recoveryMethodValues: [],
    recoveryCredential: '',
    rotatedRecoveryCode: '',
    bindingOffer: null,
    claimAvailable: true,
    authNotice: '',
    passwordStudentId: '',
    password: ''
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: copy.navigationTitle });
    this._active = true;
    this._loginSubmitting = false;
    this._portalNavigating = false;
    this._preferredSelection = {};
    this._preferredSelectionPromise = loadPreferredSelection().then((selection) => {
      this._preferredSelection = selection;
      return selection;
    });
    const authNotice = consumeRuntimeLoginNotice();
    if (authNotice) {
      this.setData({ authNotice: authNotice });
    }
    readStorageValue('authLoginNotice').then((storedNotice) => {
      if (!this._active || !storedNotice) return;
      if (!this.data.authNotice) this.setData({ authNotice: storedNotice });
      try {
        if (typeof wx.removeStorage === 'function') wx.removeStorage({ key: 'authLoginNotice' });
      } catch (_) {}
    });
  },

  openPortal() {
    if (this._portalNavigating) return;
    this._portalNavigating = true;
    this.setData({
      sheetClass: 'sheet',
      stage: 'login',
      name: '',
      studentId: '',
      claimId: '',
      recoveryRequestId: '',
      verificationCode: '',
      recoveryCredential: '',
      rotatedRecoveryCode: '',
      bindingOffer: null
    });

    const page = this;
    let settled = false;
    const finish = function(success) {
      if (settled) return;
      settled = true;
      if (page._portalNavigationTimer) {
        clearTimeout(page._portalNavigationTimer);
        page._portalNavigationTimer = null;
      }
      page._portalNavigating = false;
      if (!success) showShortToast(copy.messages.pageOpenFailed);
    };
    this._portalNavigationTimer = setTimeout(function() {
      page._portalNavigationTimer = null;
      // 超时只解除按钮忙碌状态，绝不再次发起另一种导航。旧版鸿蒙运行时
      // 处理主包切页较慢时，重入 redirectTo/reLaunch 会互相中断。
      finish(false);
    }, PORTAL_NAVIGATION_TIMEOUT_MS);

    // 登录成功后只允许一次 reLaunch。它同时清理登录页和历史页面栈，
    // 避免旧版鸿蒙运行时中多次导航竞争导致页面停留在登录态。
    if (typeof wx.reLaunch !== 'function') {
      finish(false);
      return;
    }
    wx.reLaunch({
      url: PORTAL_ROUTE,
      success: function() { finish(true); },
      fail: function() { finish(false); }
    });
  },

  onName(e) {
    this.setData({ name: String(e.detail.value || '').trim() });
  },

  onStudentId(e) {
    this.setData({ studentId: String(e.detail.value || '').trim() });
  },

  onPasswordStudentId(e) {
    this.setData({ passwordStudentId: String(e.detail.value || '').trim() });
  },

  onPasswordInput(e) {
    this.setData({ password: String(e.detail.value || '') });
  },

  openPasswordLogin() {
    this.setData({
      sheetClass: 'sheet sheet-show',
      stage: 'password',
      passwordStudentId: '',
      password: '',
      bindingOffer: null
    });
  },

  async onPasswordLogin() {
    if (this.data.loading) return;
    const validationMessage = getPasswordRequiredMessage(
      this.data.passwordStudentId,
      this.data.password,
      copy.messages
    );
    if (validationMessage) {
      showShortToast(validationMessage);
      return;
    }
    this.setData({ loading: true });
    try {
      const result = await callFunction({
        name: 'auth/password/session',
        data: {
          studentId: this.data.passwordStudentId,
          passphrase: this.data.password,
          requestBindingOffer: true
        }
      });
      if (!result || result.status !== 'login_success') throw new Error(copy.messages.loginInvalid);
      authContext.applyAuthenticatedResult(result);
      passwordBindingOffer.queue(result.bindingOfferCheck === true || Boolean(result.bindingOffer));
      this.openPortal();
    } catch (error) {
      showShortToast(getErrorText(error, copy.messages.loginInvalid));
    } finally {
      this.setData({ loading: false });
    }
  },

  onShow() {
    if (!this._portalNavigationTimer) this._portalNavigating = false;
  },

  onUnload() {
    this._active = false;
    if (this._wechatLoginCancel) this._wechatLoginCancel();
    if (this._portalNavigationTimer) {
      clearTimeout(this._portalNavigationTimer);
      this._portalNavigationTimer = null;
    }
  },

  onHide() {
    if (this._wechatLoginCancel) this._wechatLoginCancel();
    this._wechatLoginCancel = null;
    this._loginSubmitting = false;
    if (this.data.loading) this.setData({ loading: false });
  },

  onVerificationCode(e) {
    this.setData({ verificationCode: String(e.detail.value || '').trim().toUpperCase() });
  },

  onRecoveryCredential(e) {
    this.setData({ recoveryCredential: String(e.detail.value || '') });
  },

  onOrganizationChange(e) {
    const index = Number(e.detail.value || 0);
    this.setData({
      organizationIndex: index,
      organizationName: selectedOrganizationName(this.data.organizations, index)
    });
  },

  onRecoveryMethodChange(e) {
    const selected = (this.data.recoveryMethodValues || [])[Number(e.detail.value || 0)] || 'recovery_code';
    this.setData({
      recoveryMethod: selected,
      recoveryMethodIndex: Number(e.detail.value || 0),
      recoveryMethodLabel: selected === 'passphrase' ? copy.messages.recoveryPassphrase : copy.messages.recoveryCode,
      recoveryCredential: ''
    });
  },

  closeSheet() {
    if (this.data.loading) return;
    this.setData({
      sheetClass: 'sheet',
      stage: 'login',
      name: '',
      studentId: '',
      claimId: '',
      recoveryRequestId: '',
      verificationCode: '',
      recoveryCredential: '',
      bindingOffer: null
    });
  },

  onLogin() {
    if (this._loginSubmitting || this.data.loading) return;
    this._loginSubmitting = true;
    this.setData({ loading: true, authNotice: '' });
    const page = this;
    const startLogin = function() {
      if (page._active === false) return;
      page._wechatLoginCancel = requestWechatSessionDirect({
      trace: function(entry) {
        const records = page._wechatLoginTrace || [];
        page._wechatLoginTrace = records.concat([entry]).slice(-24);
        console.info('[auth:wechat:timing]', JSON.stringify(entry));
      },
      success: function(result) {
        if (page._active === false) return;
        page.setData({ loading: false });
        try { page.handleWechatSession(result); } catch (error) {
          showShortToast(getErrorText(error, copy.messages.relogin));
        }
      },
      fail: function(error) {
        if (page._active === false) return;
        const message = getErrorText(error, copy.messages.relogin);
        if (message) showShortToast(message);
      },
      complete: function() {
        page._loginSubmitting = false;
        if (page._active !== false) page.setData({ loading: false });
      }
      }, page._preferredSelection);
    };
    // 历史角色只是预填偏好；读取未完成时不等待 Promise 或 storage 回调。
    this._wechatLoginTrace = [];
    startLogin();
  },

  handleWechatSession(result) {
    if (!result || !result.status) {
      showShortToast(copy.messages.relogin);
      return;
    }
    if (result.status === 'login_success') {
      try {
        authContext.applyAuthenticatedResult(result);
        this.openPortal();
      } catch (_) {
        showShortToast(copy.messages.relogin);
      }
      return;
    }
    if (result.status !== 'need_claim' || !result.bootstrapToken) {
      showShortToast(result.message || copy.messages.loginUnavailable);
      return;
    }
    const organizations = Array.isArray(result.organizations) ? result.organizations : [];
    const recoveryMethods = [];
    const recoveryMethodValues = [];
    if (result.recoveryMethods && result.recoveryMethods.recoveryCode) {
      recoveryMethods.push(copy.messages.recoveryCode);
      recoveryMethodValues.push('recovery_code');
    }
    if (result.recoveryMethods && result.recoveryMethods.passphrase) {
      recoveryMethods.push(copy.messages.recoveryPassphrase);
      recoveryMethodValues.push('passphrase');
    }
    orgSession.commitContext({
      token: result.bootstrapToken,
      contextId: '',
      role: '',
      orgId: '',
      orgName: ''
    });
    this.setData({
      stage: 'claim',
      sheetClass: 'sheet sheet-show',
      organizations: organizations,
      organizationIndex: 0,
      organizationName: selectedOrganizationName(organizations, 0),
      claimAvailable: result.claimAvailable !== false,
      recoveryMethods,
      recoveryMethodValues,
      recoveryMethod: recoveryMethodValues[0] || '',
      recoveryMethodIndex: 0,
      recoveryMethodLabel: recoveryMethods[0] || ''
    });
  },

  switchToRecovery() {
    this.setData({
      stage: 'recovery',
      claimId: '',
      verificationCode: '',
      recoveryCredential: ''
    });
  },

  switchToClaim() {
    this.setData({
      stage: 'claim',
      recoveryRequestId: '',
      recoveryCredential: ''
    });
  },

  async submitClaim() {
    if (this.data.loading) return;
    const organization = this.data.organizations[this.data.organizationIndex];
    if (!organization || !this.data.name || !this.data.studentId) {
      showShortToast(copy.messages.profileRequired);
      return;
    }
    this.setData({ loading: true });
    try {
      const result = await callFunction({
        name: 'auth/claims',
        data: {
          organizationId: organization.id,
          name: this.data.name,
          studentId: this.data.studentId
        }
      });
      if (!result || result.status !== 'accepted' || !result.claimId) {
        showShortToast((result && result.message) || copy.messages.submitFailed);
        return;
      }
      this.setData({
        stage: 'verify',
        claimId: result.claimId,
        verificationCode: ''
      });
    } catch (error) {
      const message = getErrorText(error, copy.messages.submitFailed);
      if (message) showShortToast(message);
    } finally {
      this.setData({ loading: false });
    }
  },

  async verifyClaim() {
    if (this.data.loading) return;
    if (!this.data.claimId || !this.data.verificationCode) {
      showShortToast(copy.messages.verificationRequired);
      return;
    }
    this.setData({ loading: true });
    try {
      const organization = this.data.organizations[this.data.organizationIndex];
      try {
        const inviteResult = await callFunction({
          name: 'auth/claims/redeem',
          data: {
            organizationId: organization && organization.id,
            name: this.data.name,
            studentId: this.data.studentId,
            code: this.data.verificationCode
          }
        });
        if (inviteResult && inviteResult.status === 'login_success') {
          authContext.applyAuthenticatedResult(inviteResult);
          this.openPortal();
          return;
        }
      } catch (_) {
        // 普通认领申请继续使用原有的申请码流程。
      }
      const result = await callFunction({
        name: 'auth/claims/verify',
        data: {
          claimId: this.data.claimId,
          verificationCode: this.data.verificationCode
        }
      });
      if (!result || result.status !== 'login_success') {
        showShortToast((result && result.message) || copy.messages.verificationInvalid);
        return;
      }
      authContext.applyAuthenticatedResult(result);
      this.openPortal();
    } catch (error) {
      const message = getErrorText(error, copy.messages.verificationInvalid);
      if (message) showShortToast(message);
    } finally {
      this.setData({ loading: false });
    }
  },

  async startRecovery() {
    if (this.data.loading) return;
    const organization = this.data.organizations[this.data.organizationIndex];
    if (!organization || !this.data.name || !this.data.studentId) {
      showShortToast(copy.messages.profileRequired);
      return;
    }
    this.setData({ loading: true });
    try {
      const result = await callFunction({
        name: 'auth/recovery/start',
        data: {
          organizationId: organization.id,
          name: this.data.name,
          studentId: this.data.studentId
        }
      });
      if (!result || result.status !== 'accepted' || !result.recoveryRequestId) {
        showShortToast((result && result.message) || copy.messages.submitFailed);
        return;
      }
      this.setData({
        stage: this.data.recoveryMethodValues.length ? 'recoveryVerify' : 'recoveryPending',
        recoveryRequestId: result.recoveryRequestId,
        recoveryCredential: ''
      });
    } catch (error) {
      const message = getErrorText(error, copy.messages.submitFailed);
      if (message) showShortToast(message);
    } finally {
      this.setData({ loading: false });
    }
  },

  async completeRecovery() {
    if (this.data.loading) return;
    if (!this.data.recoveryCredential) {
      showShortToast(copy.messages.recoveryRequired);
      return;
    }
    this.setData({ loading: true });
    try {
      const result = await callFunction({
        name: 'auth/recovery/complete',
        data: {
          recoveryRequestId: this.data.recoveryRequestId,
          method: this.data.recoveryMethod,
          credential: this.data.recoveryCredential
        }
      });
      if (!result || result.status !== 'login_success') {
        showShortToast((result && result.message) || copy.messages.recoveryInvalid);
        return;
      }
      authContext.applyAuthenticatedResult(result);
      if (result.recoveryCode) {
        this.setData({
          stage: 'recoveryRotated',
          rotatedRecoveryCode: result.recoveryCode,
          recoveryCredential: ''
        });
      } else {
        this.openPortal();
      }
    } catch (error) {
      const message = getErrorText(error, copy.messages.recoveryInvalid);
      if (message) showShortToast(message);
    } finally {
      this.setData({ loading: false });
    }
  },

  copyRotatedRecoveryCode() {
    if (!this.data.rotatedRecoveryCode) return;
    wx.setClipboardData({ data: this.data.rotatedRecoveryCode });
  },

  finishRecoveredLogin() {
    this.openPortal();
  },

  async bindPasswordWechat() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      // 仅在用户明确选择绑定之后获取微信凭据，口令登录本身完全不依赖微信。
      const code = this.data.bindingOffer && this.data.bindingOffer.requiresWechatCode
        ? await requestWechatLoginCode() : '';
      const result = await callFunction({
        name: 'auth/security/bind-current-wechat',
        data: code ? { code } : {}
      });
      if (!result || result.status !== 'success') {
        throw new Error(copy.messages.pageOpenFailed);
      }
      this.openPortal();
    } catch (error) {
      showShortToast(getErrorText(error, copy.messages.pageOpenFailed));
    } finally {
      this.setData({ loading: false });
    }
  },

  skipPasswordBinding() {
    this.openPortal();
  }
});
