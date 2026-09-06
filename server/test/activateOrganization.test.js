const assert = require('assert');
const Module = require('module');

let catalogCalls = [];
const mocks = {
  '../models/systemConfig': { async get() { return { current_organization: 'org-b' }; } },
  '../services/accessibleOrganizations': {
    async listAvailableOrganizations(req, role) {
      catalogCalls.push({ accountId: req.authAccount.id, role });
      return ['org-a', 'org-b'].map((id) => ({ id, name: id, role }));
    }
  }
};
const originalLoad = Module._load;
let router;
try {
  Module._load = function(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    if (/models\/(userInfo|adminInfo)|config\/db/.test(request)) {
      throw new Error('旧协议不得查询微信绑定或写入数据库');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  router = require('../src/core/routes/auth');
} finally {
  Module._load = originalLoad;
}

async function invoke(path, req) {
  const layer = router.stack.find((item) => item.route && item.route.path === path);
  assert(layer, path);
  let statusCode = 200;
  let body;
  await layer.route.stack[0].handle(req, {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; }
  });
  return { statusCode, body };
}

async function run() {
  const authenticated = {
    authAccount: { id: 'account-one', personId: 'person-one' },
    authContext: { contextId: 'context-one', personId: 'person-one', organizationId: 'org-a', role: 'user' }
  };
  // 旧组织激活不能更新统一会话，任何旧微信、伪造角色或有效会话均不得走旁路。
  for (const req of [
    { openid: 'other-super-wechat', body: { organizationId: 'org-b', role: 'admin' }, headers: { 'x-role': 'admin' } },
    { body: { organizationId: 'missing', role: 'invalid' }, headers: {} },
    authenticated
  ]) {
    for (const route of ['/activateOrganization', '/userLogin', '/adminLogin', '/bindUserInfo', '/bindAdminInfo']) {
      const result = await invoke(route, req);
      assert.strictEqual(result.statusCode, 426);
      assert.strictEqual(result.body.status, 'client_upgrade_required');
    }
  }
  assert.strictEqual(catalogCalls.length, 0, '退役入口不能查询、激活或写入任何身份');

  for (const openid of ['', 'other-super-wechat']) {
    const user = await invoke('/listMyOrganizations', Object.assign({}, authenticated, { openid }));
    assert.strictEqual(user.body.status, 'success');
    assert.deepStrictEqual(user.body.organizations.map((item) => item.id), ['org-a', 'org-b']);
    const admin = await invoke('/admin/listMyOrganizations', Object.assign({}, authenticated, { openid }));
    assert.deepStrictEqual(admin.body.organizations.map((item) => item.id), ['org-b', 'org-a']);
  }
  assert(catalogCalls.every((item) => item.accountId === 'account-one'));
  catalogCalls = [];
  const denied = await invoke('/listMyOrganizations', { openid: 'other-super-wechat', headers: {} });
  assert.strictEqual(denied.body.status, 'auth_failed');
  assert.strictEqual(catalogCalls.length, 0);
  console.log('旧组织激活退役与统一账号组织目录测试通过');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
