'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/subpackages/main/pages/login/login.js'), 'utf8');
const copy = require('../miniprogram/locales/zh-CN/main');

function setup() {
  let definition;
  let login;
  let request;
  let headers;
  let now = 0;
  const timers = new Map();
  const records = [];
  const context = {
    Page(value) { definition = value; },
    require(name) {
      if (name.endsWith('locales/zh-CN/main')) return copy;
      if (name.endsWith('/api')) return { API_BASE: 'https://example.test/api', CLIENT_VERSION: 'test',
        createRequestId: () => 'diagnostic-test', getErrorText: () => 'failed', showShortToast() {} };
      return {};
    },
    Date: { now: () => now },
    setTimeout(fn, delay) { const key = {}; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    console: { info(...args) { records.push(args); } },
    wx: {
      login(options) { login = options; },
      request(options) { request = options; return { onHeadersReceived(fn) { headers = fn; }, abort() { throw new Error('不得依赖 abort 桥回调'); } }; }
    }
  };
  vm.runInNewContext(source, context);
  const page = Object.assign({}, definition, { data: Object.assign({}, definition.data), _active: true,
    _preferredSelectionPromise: { then() { throw new Error('不得等待偏好 Promise'); } },
    setData(values) { Object.assign(this.data, values); }, handleWechatSession() {} });
  const advance = ms => { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); } };
  return { page, advance, records, get login() { return login; }, get request() { return request; }, get headers() { return headers; } };
}

let test = setup();
test.page.onLogin();
assert(test.login, '点击即调用微信登录，不等缓存');
test.login.success({ code: 'never-log-this-code' });
assert(test.request);
test.headers();
test.advance(18000);
assert.strictEqual(test.page.data.loading, false);
assert.strictEqual(test.page._loginSubmitting, false);
test.request.success({ statusCode: 200, data: { status: 'login_success', token: 'never-log-this-token' } });
assert(test.page._wechatLoginTrace.some(row => row.stage === 'headers_received'));
assert(test.page._wechatLoginTrace.some(row => row.stage === 'late_response'));
assert(!JSON.stringify(test.records).includes('never-log'));
test = setup();
test.page.onLogin();
test.advance(18000);
test.login.success({ code: 'late-code' });
assert.strictEqual(test.request, undefined, '超时后迟到微信结果不得创建另一会话');
test = setup();
test.page.onLogin();
test.login.success({ code: 'code' });
test.request.success({ statusCode: 200, data: { status: 'login_success' } });
assert.strictEqual(test.page.data.loading, false);
assert.strictEqual(test.page._loginSubmitting, false);
test = setup();
test.page.onLogin();
test.page.onUnload();
test.advance(18000);
assert(!test.page._wechatLoginTrace.some(row => row.stage === 'total_timeout'), '卸载必须取消总计时器');
console.log('微信登录分段诊断、偏好非阻塞、超时释放、迟到结果与诊断隐私测试通过');
