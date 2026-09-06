const assert = require('assert');
const Module = require('module');

let pageDefinition = null;
let scenario = 'claim';
const calls = [];
const storage = {};
const toasts = [];
const navigations = [];
const relaunches = [];
const synchronousWrites = [];
const asynchronousWrites = [];
let wechatCalls = 0;
let wechatUnavailable = false;

async function callFunction(options) {
  calls.push({ name: options.name, data: Object.assign({}, options.data || {}) });
  if (options.name === 'auth/password/session') {
    assert.strictEqual(options.data.code, undefined, '口令登录不得提前获取微信凭据');
    assert.strictEqual(options.data.requestBindingOffer, true);
    return {
      status: 'login_success', token: 'password-access-token',
      account: { id: 'password-account', personId: 'password-person' },
      context: { contextId: 'password-context', personId: 'password-person', role: 'user', organizationId: 'org-44' },
      contexts: [{ contextId: 'password-context', personId: 'password-person', role: 'user', organizationId: 'org-44' }],
      user: { id: 'password-hr', name: '口令测试用户' },
      bindingOffer: { available: true, requiresWechatCode: true }
    };
  }
  if (options.name === 'auth/security/bind-current-wechat') {
    assert.strictEqual(options.data.code, 'fresh-wx-code');
    return { status: 'success' };
  }
  if (options.name === 'auth/wechat/session') {
    return {
      status: 'need_claim',
      bootstrapToken: 'bootstrap-token',
      organizations: [{ id: 'org-44', name: '第四十四届' }],
      recoveryMethods: { recoveryCode: false, passphrase: false }
    };
  }
  if (options.name === 'auth/claims') {
    return { status: 'accepted', claimId: 'claim-1' };
  }
  if (options.name === 'auth/claims/verify') {
    return {
      status: 'login_success',
      token: 'access-token',
      context: {
        contextId: 'assignment:one:org-44',
        role: 'user',
        organizationId: 'org-44',
        organizationName: '第四十四届'
      },
      contexts: [{
        contextId: 'assignment:one:org-44',
        role: 'user',
        organizationId: 'org-44',
        organizationName: '第四十四届'
      }],
      user: { id: 'hr-1', name: '测试用户' }
    };
  }
  if (options.name === 'auth/recovery/start' && scenario === 'recovery') {
    return { status: 'accepted', recoveryRequestId: 'recovery-1' };
  }
  throw new Error('未预期的 API 调用：' + options.name);
}

global.wx = {
  setNavigationBarTitle() {},
  getStorageSync(key) { return storage[key]; },
  setStorageSync(key, value) {
    synchronousWrites.push(key);
    storage[key] = value;
  },
  removeStorageSync(key) { delete storage[key]; },
  setStorage(options) {
    asynchronousWrites.push(options.key);
    storage[options.key] = options.data;
    if (typeof options.success === 'function') options.success();
  },
  batchSetStorage(options) {
    (options.kvList || []).forEach(function(item) { storage[item.key] = item.value; });
    if (typeof options.success === 'function') options.success();
  },
  removeStorage(options) {
    delete storage[options.key];
    if (typeof options.success === 'function') options.success();
  },
  login(options) {
    wechatCalls += 1;
    if (wechatUnavailable) options.fail({ errMsg: 'fixture-unavailable' });
    else options.success({ code: 'fresh-wx-code' });
  },
  request(options) {
    if (!options.url.endsWith('/auth/wechat/session')) {
      throw new Error('未预期的原生请求：' + options.url);
    }
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(options, 'dataType'),
      false,
      '鸿蒙微信登录必须沿用原生默认 JSON 解析'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(options, 'responseType'),
      false,
      '鸿蒙微信登录不得强制 text 响应模式'
    );
    calls.push({ name: 'auth/wechat/session', data: Object.assign({}, options.data || {}) });
    setTimeout(function() {
      if (scenario === 'directLogin') {
        options.success({
          statusCode: 200,
          data: JSON.stringify({
            status: 'login_success',
            token: 'direct-access-token',
            context: {
              contextId: 'assignment:direct:org-44',
              role: 'user',
              organizationId: 'org-44',
              organizationName: '第四十四届',
              assignmentId: 'assignment:direct'
            },
            contexts: [{
              contextId: 'assignment:direct:org-44',
              role: 'user',
              organizationId: 'org-44',
              organizationName: '第四十四届',
              assignmentId: 'assignment:direct'
            }],
            user: { id: 'hr-direct', name: '真机测试用户' }
          })
        });
        return;
      }
      options.success({
        statusCode: 200,
        data: {
          status: 'need_claim',
          bootstrapToken: 'bootstrap-token',
          organizations: [{ id: 'org-44', name: '第四十四届' }],
          recoveryMethods: { recoveryCode: false, passphrase: false }
        }
      });
    }, 0);
    return { abort() {} };
  },
  showToast(options) { toasts.push(options); },
  nextTick(callback) { callback(); },
  navigateTo(options) {
    navigations.push(options.url);
    if (typeof options.success === 'function') options.success();
  },
  reLaunch(options) {
    relaunches.push(options.url);
    if (typeof options.success === 'function') options.success();
  }
};
global.Page = function(definition) { pageDefinition = definition; };

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../../../../utils/deviceIdentity') {
    throw new Error('登录流程不得加载设备标识模块');
  }
  if (request === '../../../../utils/api') {
    return {
      API_BASE: 'https://example.test/api',
      CLIENT_VERSION: 'test-client',
      callFunction,
      createRequestId() { return 'test-request-id'; },
      showShortToast(title, icon) { toasts.push({ title, icon: icon || 'none' }); },
      getErrorText(error, fallback) { return error && error.message ? error.message : fallback; }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require('../miniprogram/subpackages/main/pages/login/login');
Module._load = originalLoad;
const orgSession = require('../miniprogram/utils/orgSession');

function createPage(overrides) {
  const page = Object.assign({}, pageDefinition);
  page.data = Object.assign({}, pageDefinition.data, overrides || {});
  page.setData = function(changes, callback) {
    Object.assign(this.data, changes || {});
    if (typeof callback === 'function') callback();
  };
  return page;
}

async function run() {
  assert(pageDefinition, '登录页应成功注册');

  const page = createPage();
  page.onLoad();
  page.onLogin();
  page.onLogin();
  await new Promise(function(resolve) { setTimeout(resolve, 20); });
  assert.strictEqual(calls.filter((item) => item.name === 'auth/wechat/session').length, 1);
  const wechatLoginCall = calls.find((item) => item.name === 'auth/wechat/session');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(wechatLoginCall.data, 'deviceId'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(wechatLoginCall.data, 'devicePlatform'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(wechatLoginCall.data, 'deviceModel'), false);
  assert.strictEqual(page.data.stage, 'claim');

  page.setData({ name: '测试用户', studentId: '20260001' });
  await page.submitClaim();
  assert.strictEqual(page.data.stage, 'verify');
  assert.strictEqual(page.data.claimId, 'claim-1');

  page.setData({ verificationCode: 'ABCD1234' });
  const writesBeforeLoginCommit = synchronousWrites.length;
  await page.verifyClaim();
  assert.strictEqual(orgSession.getSnapshot().token, 'access-token');
  assert.strictEqual(orgSession.getSnapshot().contextId, 'assignment:one:org-44');
  assert.strictEqual(
    synchronousWrites.length - writesBeforeLoginCommit,
    0,
    '认领成功后的登录临界路径不得同步落盘'
  );
  assert(
    !synchronousWrites.slice(writesBeforeLoginCommit).includes('authSession'),
    '登录临界路径不得同步写入紧凑会话'
  );
  assert(relaunches.includes('/subpackages/main/pages/portal/portal'));
  assert.strictEqual(page.data.stage, 'login', '进入门户前必须卸载登录页认证弹层');

  scenario = 'recovery';
  const recoveryPage = createPage({
    stage: 'recovery',
    organizations: [{ id: 'org-44', name: '第四十四届' }],
    name: '测试用户',
    studentId: '20260001',
    recoveryMethodValues: []
  });
  await recoveryPage.startRecovery();
  assert.strictEqual(recoveryPage.data.stage, 'recoveryPending');
  assert.strictEqual(recoveryPage.data.recoveryRequestId, 'recovery-1');

  scenario = 'directLogin';
  const directPage = createPage();
  directPage.onLoad();
  const directWritesBefore = synchronousWrites.length;
  directPage.onLogin();
  await new Promise(function(resolve) { setTimeout(resolve, 20); });
  assert.strictEqual(directPage.data.loading, false, '微信登录响应后必须立即解除按钮加载态');
  assert.strictEqual(directPage._loginSubmitting, false, '微信登录完成后必须释放防重复提交锁');
  assert.strictEqual(orgSession.getSnapshot().token, 'direct-access-token');
  assert.strictEqual(synchronousWrites.length - directWritesBefore, 0, '微信登录不得同步落盘');
  assert(asynchronousWrites.includes('authSession'), '紧凑会话必须异步投递');
  assert.strictEqual(relaunches[relaunches.length - 1], '/subpackages/main/pages/portal/portal');

  wechatUnavailable = true;
  const beforePasswordWechat = wechatCalls;
  const passwordPage = createPage({ passwordStudentId: 'fixture-user', password: 'fixture-passphrase' });
  await passwordPage.onPasswordLogin();
  assert.strictEqual(wechatCalls, beforePasswordWechat, '微信完全不可用时口令也必须成功');
  assert.strictEqual(orgSession.getSnapshot().token, 'password-access-token');
  assert.strictEqual(passwordPage.data.stage, 'passwordBinding');
  assert.strictEqual(passwordPage.data.loading, false);
  const beforeBindingRequests = calls.filter((item) => item.name === 'auth/security/bind-current-wechat').length;
  await passwordPage.bindPasswordWechat();
  assert.strictEqual(orgSession.getSnapshot().token, 'password-access-token', '绑定失败不得清理成功口令会话');
  assert.strictEqual(calls.filter((item) => item.name === 'auth/security/bind-current-wechat').length, beforeBindingRequests);
  wechatUnavailable = false;
  await passwordPage.bindPasswordWechat();
  assert.strictEqual(calls.filter((item) => item.name === 'auth/security/bind-current-wechat').length, beforeBindingRequests + 1);
  assert.strictEqual(orgSession.getSnapshot().token, 'password-access-token');

  console.log('统一登录、认领、可选微信绑定与默认人工恢复流程测试通过');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
