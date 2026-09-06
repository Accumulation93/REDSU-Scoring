'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

process.env.DB_USER = process.env.DB_USER || 'passphrase_binding_test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'passphrase_binding_test';

class IdentityError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus || 400;
  }
}

let scenario;

const identityModel = {
  IdentityError,
  async authenticateWithPassphrase() {
    return scenario.bound
      ? { id: 'account-1', person_id: 'person-1', openid_hash: 'bound-hash' }
      : { id: 'account-1', person_id: 'person-1', openid_hash: null };
  },
  async bindWechatAfterPassphraseLogin(accountId, openid) {
    scenario.bindCalls += 1;
    assert.strictEqual(accountId, 'account-1');
    assert.strictEqual(openid, 'wechat-openid');
    if (scenario.conflict) throw new IdentityError('wechat_conflict', '该微信已绑定其他账号', 409);
    return { id: 'account-1', person_id: 'person-1', openid_hash: 'new-hash' };
  },
  async findAccountByOpenid(openid) {
    return scenario.currentBound || null;
  },
  temporaryPasswordSessionOptions(openid) {
    scenario.temporaryOptionsCalls += 1;
    assert(['', 'wechat-openid'].includes(openid));
    return { temporary: true, openidHash: 'temp-hash', openidCiphertext: 'temp-cipher' };
  },
  async appendAuditEvent() {
    scenario.auditCalls += 1;
  }
};

const unifiedAuth = {
  async exchangeWechatCode(code) {
    scenario.exchangeCalls += 1;
    if (scenario.exchangeFailed) throw new IdentityError('wechat_unavailable', 'fixture failure', 503);
    if (code !== undefined) assert.strictEqual(code, 'fresh-code');
    return 'wechat-openid';
  },
  async createAuthenticatedSession(account, selection, metadata, options) {
    scenario.sessionCalls += 1;
    scenario.lastSessionOptions = options;
    assert(account.openid_hash || (options && options.temporary));
    return { status: 'login_success' };
  }
};

const mocks = {
  '../../config/db': { async withTransaction(callback) { return callback({}); } },
  '../models/unifiedIdentity': identityModel,
  '../services/unifiedAuth': unifiedAuth,
  '../models/systemConfig': { async get() { return { timezone: 8, timezone_config_version: 1 }; } },
  '../services/adminPermissions': {
    scopeAccountSessions(items) { return items; }
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const router = require('../src/core/routes/unifiedAuth');
Module._load = originalLoad;

function handlerFor(routePath) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert(layer, '缺少路由：' + routePath);
  return layer.route.stack[0].handle;
}

async function invoke(body, authenticated, routePath = '/auth/password/session') {
  let payload;
  let statusCode = 200;
  const req = {
    body,
    requestId: 'request-1',
    ip: '127.0.0.1',
    path: routePath,
    logger: { error() {} }
  };
  Object.assign(req, authenticated || {});
  const res = {
    status(value) { statusCode = value; return this; },
    json(value) { payload = value; return value; }
  };
  await handlerFor(routePath)(req, res);
  return { payload, statusCode };
}

async function run() {
  scenario = { bound: false, conflict: false, currentBound: null, exchangeCalls: 0, bindCalls: 0, auditCalls: 0, sessionCalls: 0, temporaryOptionsCalls: 0 };
  const firstLogin = await invoke({ studentId: '20260001', passphrase: 'Strong-Passphrase-2026', code: 'fresh-code' });
  assert.strictEqual(firstLogin.payload.status, 'login_success');
  assert.deepStrictEqual(
    [scenario.exchangeCalls, scenario.bindCalls, scenario.auditCalls, scenario.sessionCalls, scenario.temporaryOptionsCalls],
    [1, 0, 1, 1, 1],
    '未绑定账号应先建立临时口令会话，再提示用户选择是否绑定当前微信'
  );
  assert.strictEqual(firstLogin.payload.bindingOffer.available, true);
  assert.strictEqual(firstLogin.payload.bindingOffer.currentWechatBound, false);

  scenario = { bound: true, conflict: false, currentBound: null, exchangeCalls: 0, bindCalls: 0, auditCalls: 0, sessionCalls: 0, temporaryOptionsCalls: 0 };
  const legacyClient = await invoke({ studentId: '20260001', passphrase: 'Strong-Passphrase-2026' });
  assert.strictEqual(legacyClient.payload.status, 'login_success');
  assert.deepStrictEqual(
    [scenario.exchangeCalls, scenario.bindCalls, scenario.auditCalls, scenario.sessionCalls, scenario.temporaryOptionsCalls],
    [0, 0, 1, 1, 1],
    '已有绑定的账号必须兼容未提交 code 的旧客户端'
  );

  scenario = { bound: false, conflict: false, currentBound: { id: 'account-other' }, exchangeCalls: 0, bindCalls: 0, auditCalls: 0, sessionCalls: 0, temporaryOptionsCalls: 0 };
  const blockedBinding = await invoke({ studentId: '20260001', passphrase: 'Strong-Passphrase-2026', code: 'fresh-code' });
  assert.strictEqual(blockedBinding.statusCode, 200);
  assert.strictEqual(blockedBinding.payload.status, 'login_success');
  assert.strictEqual(blockedBinding.payload.bindingOffer.available, false);
  assert.strictEqual(blockedBinding.payload.bindingOffer.currentWechatBound, true);
  assert.strictEqual(scenario.sessionCalls, 1, '临时口令登录不因当前微信已绑定其他账号而阻止登录');

  for (const exchangeFailed of [false, true]) {
    scenario = { bound: false, exchangeFailed, exchangeCalls: 0, bindCalls: 0, auditCalls: 0, sessionCalls: 0, temporaryOptionsCalls: 0 };
    const result = await invoke({
      studentId: '20260001', passphrase: 'Strong-Passphrase-2026',
      ...(exchangeFailed ? { code: 'fresh-code' } : {})
    });
    assert.strictEqual(result.payload.status, 'login_success', '缺少或无效微信 code 不得阻断正确口令');
    assert.strictEqual(result.payload.bindingOffer, undefined, '没有验证过的微信不得展示可绑定邀请');
    assert.strictEqual(scenario.bindCalls, 0);
    assert.strictEqual(scenario.lastSessionOptions.temporary, true);
  }

  scenario = { bound: false, exchangeCalls: 0, bindCalls: 0, auditCalls: 0, sessionCalls: 0, temporaryOptionsCalls: 0 };
  const deferred = await invoke({ studentId: 'fixture-user', passphrase: 'fixture-passphrase', requestBindingOffer: true });
  assert.strictEqual(deferred.payload.status, 'login_success');
  assert.strictEqual(deferred.payload.bindingOffer.requiresWechatCode, true);
  assert.strictEqual(scenario.exchangeCalls, 0, '新版口令入口不交换微信凭据');
  const authenticated = {
    authAccount: { id: 'account-1', personId: 'person-1' },
    authContext: { contextId: 'context-1', personId: 'person-1' },
    authSession: { id: 'session-1', binding_mode: 'temporary' }
  };
  const bound = await invoke({ code: 'fresh-code', accountId: 'forged' }, authenticated, '/auth/security/bind-current-wechat');
  assert.strictEqual(bound.payload.status, 'success');
  assert.strictEqual(scenario.bindCalls, 1);
  scenario.conflict = true;
  const conflict = await invoke({ code: 'fresh-code' }, authenticated, '/auth/security/bind-current-wechat');
  assert.strictEqual(conflict.statusCode, 409);
  authenticated.authSession.binding_mode = 'bound';
  const wrongMode = await invoke({ code: 'fresh-code' }, authenticated, '/auth/security/bind-current-wechat');
  assert.strictEqual(wrongMode.statusCode, 400);
  const modelSource = fs.readFileSync(
    path.resolve(__dirname, '../src/core/models/unifiedIdentity.js'),
    'utf8'
  );
  const bindingStart = modelSource.indexOf('async function bindWechatAfterPassphraseLogin');
  const bindingEnd = modelSource.indexOf('\nmodule.exports = {', bindingStart);
  const bindingBody = modelSource.slice(bindingStart, bindingEnd);
  assert.match(bindingBody, /findAccountByOpenid\(normalizedOpenid, connection\)/);
  assert.match(bindingBody, /insertActiveWechatBinding\(connection, normalizedAccountId, normalizedOpenid\)/);
  assert.match(bindingBody, /syncLegacyBindings\(connection, normalizedAccountId, normalizedOpenid\)/);
  assert.match(bindingBody, /eventType: 'password_wechat_binding_created'/);

  console.log('口令首次登录微信绑定与旧客户端兼容测试通过');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
