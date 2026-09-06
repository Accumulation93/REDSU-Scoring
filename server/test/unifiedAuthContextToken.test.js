const assert = require('assert');
const jwt = require('jsonwebtoken');
const Module = require('module');

process.env.JWT_SECRET = 'unified-context-token-test-secret';
process.env.AUTH_IDENTITY_SECRET = 'unified-context-token-identity-secret-32';
process.env.WECHAT_APPID = 'test-app';
process.env.WECHAT_SECRET = 'test-secret';

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../../middleware/auth') {
    return { JWT_SECRET: process.env.JWT_SECRET };
  }
  if (request === '../models/unifiedIdentity') {
    return { SESSION_MINUTES: 30, async listContexts() {
      return [{ contextId: 'ctx-current', organizationId: 'org-1', role: 'user', assignmentId: 'assignment-1' }];
    } };
  }
  if (request === '../models/adminInfo') return {};
  if (request === './adminPermissions') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const unifiedAuth = require('../src/core/services/unifiedAuth');
Module._load = originalLoad;

const signed = unifiedAuth.signAccessToken(
  { id: 'session-1', context: { contextId: 'ctx-current' } },
  { id: 'account-1', token_version: 3 }
);
const decoded = jwt.verify(signed, process.env.JWT_SECRET, {
  algorithms: ['HS256'],
  audience: 'whusu-smart-workspace-api',
  issuer: 'whusu-smart-workspace'
});
assert.strictEqual(decoded.contextId, 'ctx-current');

async function loadMiddleware(contextId) {
  const middlewarePath = require.resolve('../src/middleware/auth');
  delete require.cache[middlewarePath];
  Module._load = function(request, parent, isMain) {
    if (request === '../core/models/unifiedIdentity') {
      return {
        async loadSession() {
          return {
            session: {
              id: 'session-1',
              account_id: 'account-1',
              person_id: 'person-1',
              token_version: 3,
              account_token_version: 3,
              name: '测试用户',
              student_id: '20260001'
            },
            context: {
              contextId,
              organizationId: 'org-1',
              role: 'user'
            },
            openid: 'openid-1'
          };
        }
      };
    }
    if (request === '../utils/logger') {
      return { logger: { warn() {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const middleware = require(middlewarePath).authMiddleware;
  Module._load = originalLoad;
  return middleware;
}

async function invoke(middleware, token = signed) {
  let statusCode = 200;
  let body = null;
  let nextCalled = false;
  await middleware(
    {
      path: '/api/auth/contexts',
      headers: { authorization: 'Bearer ' + token },
      requestId: 'request-1'
    },
    {
      status(value) {
        statusCode = value;
        return this;
      },
      json(value) {
        body = value;
        return value;
      }
    },
    () => { nextCalled = true; }
  );
  return { statusCode, body, nextCalled };
}

(async () => {
  for (const selectionFallback of [false, true]) {
    const payload = await unifiedAuth.buildAuthenticatedPayload(
      { id: 'account-1', token_version: 3 },
      { id: 'session-1', context: { contextId: 'ctx-current' }, selectionFallback, expiresInSeconds: 1800 }
    );
    assert.strictEqual(payload.selectionNotice, '', '正常登录及偏好回退均不得误报岗位资料更新');
    assert.strictEqual(payload.context.contextId, 'ctx-current');
    assert.strictEqual(payload.selection.assignmentId, 'assignment-1');
    assert.strictEqual(payload.status, 'login_success');
  }
  const stale = await invoke(await loadMiddleware('ctx-after-switch'));
  assert.strictEqual(stale.statusCode, 401);
  assert.strictEqual(stale.body.status, 'auth_failed');
  assert.strictEqual(stale.nextCalled, false);

  const current = await invoke(await loadMiddleware('ctx-current'));
  assert.strictEqual(current.nextCalled, true);

  const legacy = jwt.sign({ openid: 'openid-1' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const rejectedLegacy = await invoke(await loadMiddleware('ctx-current'), legacy);
  assert.strictEqual(rejectedLegacy.statusCode, 401);
  assert.strictEqual(rejectedLegacy.body.status, 'auth_failed');
  assert.strictEqual(rejectedLegacy.nextCalled, false);

  console.log('统一访问令牌上下文绑定、切换失效与旧令牌拒绝测试通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
