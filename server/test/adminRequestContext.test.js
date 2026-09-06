const assert = require('assert');
const Module = require('module');

let requestedLegacyId = '';
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../models/adminInfo') {
    return {
      async getByIdGlobal(id) {
        requestedLegacyId = id;
        return id === 'legacy-admin' ? {
          id,
          admin_level: 'admin',
          org_id: 'stale-org',
          name: '旧姓名'
        } : null;
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { resolveCurrentAdmin } = require('../src/core/services/adminRequestContext');
Module._load = originalLoad;

(async () => {
  const superAdmin = await resolveCurrentAdmin({
    openid: 'openid-super',
    authAccount: { id: 'account-super', personId: 'person-super' },
    authContext: {
      role: 'admin',
      contextId: 'ctx-super-org-43',
      organizationId: 'org-43',
      adminGrantId: 'grant-super',
      legacyAdminId: '',
      adminLevel: 'super_admin',
      personId: 'person-super',
      name: '超级管理员',
      studentId: '20230001'
    }
  });
  assert.strictEqual(superAdmin.id, 'grant-super');
  assert.strictEqual(superAdmin.admin_level, 'super_admin');
  assert.strictEqual(superAdmin.org_id, '');
  assert.strictEqual(superAdmin.context_id, 'ctx-super-org-43');
  assert.strictEqual(requestedLegacyId, '', '无 legacy 记录的统一超级管理员不得再次按 OpenID 查询');

  const regularAdmin = await resolveCurrentAdmin({
    openid: 'openid-admin',
    authAccount: { id: 'account-admin', personId: 'person-admin' },
    authContext: {
      role: 'admin',
      contextId: 'ctx-admin-org-44',
      organizationId: 'org-44',
      adminGrantId: 'grant-admin',
      legacyAdminId: 'legacy-admin',
      adminLevel: 'admin',
      personId: 'person-admin',
      name: '当前姓名'
    }
  });
  assert.strictEqual(requestedLegacyId, '', '当前管理资料只投影认证角色，不读取旧绑定资料');
  assert.strictEqual(regularAdmin.id, 'legacy-admin');
  assert.strictEqual(regularAdmin.org_id, 'org-44', '当前组织必须覆盖 legacy 资料中的旧组织');
  assert.strictEqual(regularAdmin.name, '当前姓名');

  assert.strictEqual(await resolveCurrentAdmin({ authAccount: {}, authContext: { role: 'user' } }), null);
  const request = {
    authAccount: { id: 'account-admin', personId: 'person-admin' },
    authContext: {
      role: 'admin', contextId: 'ctx-admin', organizationId: 'org-44',
      personId: 'person-admin', adminGrantId: 'grant-admin', adminLevel: 'admin', name: '本人'
    }
  };
  const expected = await resolveCurrentAdmin(request);
  for (const openid of ['', 'own-wechat', 'another-super-admin-wechat']) {
    assert.deepStrictEqual(await resolveCurrentAdmin(Object.assign({}, request, { openid })), expected);
  }
  assert.strictEqual(await resolveCurrentAdmin({ openid: 'another-super-admin-wechat' }), null);
  assert.strictEqual(await resolveCurrentAdmin(Object.assign({}, request, {
    authAccount: { id: 'account-other', personId: 'person-other' }
  })), null, '账号与角色的自然人不一致必须拒绝');
  const { resolveRequestAdmin } = require('../src/core/services/adminRequestContext');
  assert.strictEqual(await resolveRequestAdmin(Object.assign({}, request, { admin: null })), null);
  assert.deepStrictEqual(await resolveRequestAdmin(Object.assign({}, request, { admin: expected })), expected);
  console.log('统一会话管理员解析测试通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
