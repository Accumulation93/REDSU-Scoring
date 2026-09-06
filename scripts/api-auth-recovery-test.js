const assert = require('assert');
const storage = {};
const requests = [];
const relaunches = [];
let loginCalls = 0;
global.getApp = function() { return null; };
global.wx = {
  getStorageSync(key) { return storage[key]; },
  setStorageSync(key, value) { storage[key] = value; },
  removeStorageSync(key) { delete storage[key]; },
  login() { loginCalls += 1; throw new Error('过期业务请求不得重新以当前微信登录'); },
  showToast() {},
  reLaunch(options) { relaunches.push(options.url); if (options.success) options.success(); },
  request(options) {
    requests.push(options);
    options.success({ statusCode: 401, data: { status: 'auth_failed' }, header: {} });
  }
};
const api = require('../miniprogram/utils/api');
const orgSession = require('../miniprogram/utils/orgSession');
async function run() {
  for (const mode of ['password', 'wechat']) {
    api.markAuthenticationReady();
    orgSession.commitFastContext({ token: mode + '-expired', orgId: 'org-one', role: 'user', contextId: 'ctx-one' });
    await assert.rejects(api.callFunction({ name: 'getCurrentOrganization' }), (error) => error.silent === true);
    assert.strictEqual(orgSession.getSnapshot().token || '', '');
    assert.strictEqual(storage.authLoginNotice, '登录已过期，请重新登录');
  }
  assert.strictEqual(requests.length, 2, '失效请求不得自动换号或重放');
  assert.strictEqual(loginCalls, 0);
  assert(relaunches.every((url) => url === '/subpackages/main/pages/login/login?reason=expired'));
  assert.strictEqual(relaunches.length, 2);

  api.markAuthenticationReady();
  const before = relaunches.length;
  await assert.rejects(api.callFunction({ name: 'auth/password/session' }), (error) => !error.silent);
  assert.strictEqual(relaunches.length, before, '登录入口自身失败应留在当前表单');
  console.log('两种登录过期均不自动换号、不重放业务操作测试通过');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
