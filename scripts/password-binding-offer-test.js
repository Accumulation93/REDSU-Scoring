const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function fixture(throwAt) {
  const state = { token: 'test-token', contextId: 'test-context', orgId: 'test-org' };
  const timers = new Map();
  const logins = [];
  const requests = [];
  const modals = [];
  const toasts = [];
  let timerId = 0;
  const target = { exports: {} };
  const page = { _isPageVisible: true };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/passwordBindingOffer.js'), 'utf8'), {
    module: target,
    require(name) {
      if (name === './orgSession') return { getSnapshot: () => Object.assign({}, state) };
      if (name === './api') return { showShortToast: text => toasts.push(text),
        requestOptionalWechatBinding(options) {
          if (throwAt === 'request') throw new Error('fixture');
          requests.push(options); return { abort() { options.aborted = true; } };
        } };
      if (name === '../locales/zh-CN/main') return require('../miniprogram/locales/zh-CN/main');
      throw new Error(name);
    },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    wx: {
      login(options) { if (throwAt === 'login') throw new Error('fixture'); logins.push(options); },
      showModal(options) { if (throwAt === 'modal') throw new Error('fixture'); modals.push(options); }
    }
  });
  const api = target.exports;
  const tick = () => { const pending = Array.from(timers.entries()); timers.clear(); pending.forEach(item => item[1]()); };
  const begin = () => { api.queue(true); api.start(page); tick(); };
  const code = () => logins[logins.length - 1].success({ code: 'test-code-' + logins.length });
  const response = (data, statusCode = 200) => requests[requests.length - 1].success({ statusCode, data });
  return { state, page, timers, logins, requests, modals, toasts, api, tick, begin, code, response };
}

for (const throwAt of ['login', 'request', 'modal']) {
  const f = fixture(throwAt); f.begin();
  if (throwAt !== 'login') f.code();
  if (throwAt === 'modal') f.response({ status: 'success', available: true });
  assert.strictEqual(f.timers.size, 0, '原生能力同步抛错必须清理并静默结束');
}
for (const available of [false, undefined, null, 1, 'true']) {
  const f = fixture();
  f.begin(); f.code(); f.response({ status: 'success', available });
  assert.strictEqual(f.modals.length, 0, '已占用、未知或非布尔真均不得提示绑定');
  assert.strictEqual(f.requests.length, 1);
}
for (const mode of ['wechat-fail', 'wechat-timeout', 'network', '401', 'malformed']) {
  const f = fixture(); f.begin();
  if (mode === 'wechat-fail') f.logins[0].fail();
  else if (mode === 'wechat-timeout') { f.tick(); f.code(); }
  else { f.code();
    if (mode === 'network') f.requests[0].fail();
    else if (mode === '401') f.response({ status: 'login_required' }, 401);
    else f.response('{broken');
  }
  assert.strictEqual(f.modals.length, 0);
  assert.strictEqual(f.toasts.length, 0, '可选检查失败不打扰已登录用户');
  assert.strictEqual(f.state.token, 'test-token');
  assert.strictEqual(f.timers.size, 0);
}
for (const point of ['before-start', 'wechat', 'request', 'confirm']) {
  const f = fixture(); f.api.queue(true);
  if (point === 'before-start') f.state.token = 'other-token';
  f.api.start(f.page); f.tick();
  if (point === 'before-start') { assert.strictEqual(f.logins.length, 0); continue; }
  if (point === 'wechat') { f.api.cancel(f.page); f.code(); }
  else { f.code();
    if (point === 'request') { f.state.contextId = 'other-context'; f.response({ status: 'success', available: true }); }
    else { f.response({ status: 'success', available: true }); f.state.token = 'other-token'; f.modals[0].success({ confirm: true }); }
  }
  assert(f.requests.length <= 1, '离页或身份变化后不得绑定');
  assert.strictEqual(f.logins.length, 1);
}
{
  const f = fixture(); f.begin(); f.code(); f.response({ status: 'success', available: true });
  assert.strictEqual(f.modals.length, 1);
  f.modals[0].success({ confirm: false });
  f.api.start(f.page); f.tick();
  assert.strictEqual(f.logins.length, 1, '取消后及重进门户均不得重复邀请');
  assert.strictEqual(f.requests.length, 1);
}
for (const statusCode of [200, 409]) {
  const f = fixture(); f.begin(); f.code(); f.response({ status: 'success', available: true });
  assert.strictEqual(f.requests.length, 1, '确认前只检查不绑定');
  f.modals[0].success({ confirm: true }); f.code();
  assert.strictEqual(f.requests.length, 2);
  assert.strictEqual(f.requests[1].name, 'auth/security/bind-current-wechat');
  assert.notStrictEqual(f.requests[0].code, f.requests[1].code, '最终绑定必须获取新 code');
  assert.strictEqual(f.requests[1].session.token, 'test-token');
  f.response({ status: statusCode === 200 ? 'success' : 'wechat_conflict' }, statusCode);
  assert.strictEqual(f.toasts.length, 1);
  assert.strictEqual(f.state.token, 'test-token', '绑定失败不能退出口令会话');
  assert.strictEqual(f.timers.size, 0);
}
console.log('登录后微信绑定资格、失败隔离、取消及身份切换测试通过');

{
  const state = { token: 'test-token', contextId: 'test-context', orgId: 'test-org', role: 'user' };
  const requests = [];
  let failed = 0;
  let succeeded = 0;
  const target = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/api.js'), 'utf8'), {
    module: target,
    require(name) {
      if (name === './orgSession') return { getSnapshot: () => Object.assign({}, state) };
      if (name === './dateTime') return {};
      if (name === '../locales/zh-CN/generated/utils/api') return {};
      throw new Error(name);
    },
    wx: { request(options) { requests.push(options); return { abort() {} }; } }
  });
  const options = { name: 'auth/security/wechat-binding-offer', session: Object.assign({}, state),
    code: 'test-code', fail: () => failed++, success: () => succeeded++ };
  const send = target.exports.requestOptionalWechatBinding;
  send(Object.assign({}, options, { name: 'deletePersonPermanently' }));
  assert.strictEqual(requests.length, 0, '可选旁路必须限制为两个绑定接口');
  send(options);
  assert.strictEqual(requests[0].header.Authorization, 'Bearer test-token');
  assert.deepStrictEqual(Object.keys(requests[0].data), ['code']);
  requests[0].success({ statusCode: 401, data: {} });
  assert.strictEqual(requests.length, 1, '401不得刷新认证或重放');
  assert.strictEqual(state.token, 'test-token');
  state.token = 'other-token';
  requests[0].success({ statusCode: 200, data: {} });
  send(options);
  assert.strictEqual(requests.length, 1, '旧会话不得发送请求');
  assert.strictEqual(succeeded, 1, '旧会话响应必须作废');
  assert.strictEqual(failed, 3);
}
