const assert = require('assert');
const Module = require('module');

const permissionByAdminId = {
  'super-1': { isSuper: true, permissions: {} },
  'hr-only': { isSuper: false, permissions: { 'hr.people': true } },
  'profile-reviewer': { isSuper: false, permissions: { 'hr.profile_review': true } },
  'account-governor': { isSuper: false, permissions: { 'auth.accounts.global_manage': true } },
  'admin-reader': { isSuper: false, permissions: { 'system.admin_accounts.read': true } },
  'admin-writer': { isSuper: false, permissions: { 'system.admin_accounts.write': true } }
};

let lockedLookup = null;
const mocks = {
  '../models/adminInfo': {
    async getActiveGrantForAccountInOrganization(accountId, personId, orgId, connection, lock) {
      lockedLookup = { accountId, personId, orgId, connection, lock };
      if (orgId === 'org-denied') return null;
      return { id: orgId === 'org-44' ? 'admin-writer' : 'hr-only', admin_level: 'admin', org_id: orgId };
    }
  },
  './accessibleOrganizations': {
    async listAccessibleActorContexts() {
      return [
        { organizationId: 'org-44', organizationName: '第四十四届', actor: { profile: { id: 'admin-writer' } } },
        { organizationId: 'org-43', organizationName: '第四十三届', actor: { profile: { id: 'hr-only' } } },
        { organizationId: 'org-college', organizationName: '学院学生会', actor: { profile: { id: 'admin-reader' } } },
        { organizationId: 'org-review', organizationName: '资料审核组织', actor: { profile: { id: 'profile-reviewer' } } }
        ,{ organizationId: 'org-account', organizationName: '账号治理组织', actor: { profile: { id: 'account-governor' } } }
      ];
    }
  },
  './adminPermissions': {
    async loadEffectivePermissions(admin) {
      return permissionByAdminId[admin.id] || { isSuper: false, permissions: {} };
    },
    hasAnyPermission(effective, keys) {
      return Boolean(effective && (effective.isSuper || keys.some((key) => effective.permissions[key])));
    }
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const {
  AdminOrganizationAccessError,
  listAdminOrganizationAccess,
  requireAdminOrganizationPermission
} = require('../src/core/services/adminOrganizationAccess');
Module._load = originalLoad;

(async () => {
  const req = {
    openid: 'openid-1',
    authAccount: { id: 'account-1', personId: 'person-1' },
    authContext: { role: 'admin', contextId: 'ctx-1', personId: 'person-1', organizationId: 'org-44' }
  };
  const access = await listAdminOrganizationAccess(req);
  assert.deepStrictEqual(access.map((item) => item.organizationId), ['org-44', 'org-43', 'org-college', 'org-review', 'org-account']);
  assert.strictEqual(access[0].canEditAdmins, true);
  assert.strictEqual(access[0].canReadAssignments, false);
  assert.strictEqual(access[1].canReadAssignments, true);
  assert.strictEqual(access[1].canReadAdmins, false);
  assert.strictEqual(access[2].canReadAdmins, true);
  assert.strictEqual(access[2].canEditAdmins, false);
  assert.strictEqual(access[3].canReadPeople, true);
  assert.strictEqual(access[3].canReadAssignments, true);
  assert.strictEqual(access[3].canEditAssignments, false);
  assert.strictEqual(access[3].canReadAdmins, false);
  assert.strictEqual(access[4].canReadPeople, true);
  assert.strictEqual(access[4].canReadAssignments, false);
  assert.strictEqual(access[4].canEditAssignments, false);

  const connection = { marker: 'transaction' };
  const allowed = await requireAdminOrganizationPermission(
    req,
    'org-44',
    ['system.admin_accounts.write'],
    connection
  );
  assert.strictEqual(allowed.organizationId, 'org-44');
  assert.deepStrictEqual(lockedLookup, {
    accountId: 'account-1', personId: 'person-1',
    orgId: 'org-44',
    connection,
    lock: true
  });

  await assert.rejects(
    () => requireAdminOrganizationPermission(req, 'org-43', ['system.admin_accounts.write']),
    (error) => error instanceof AdminOrganizationAccessError
      && error.code === 'permission_denied'
      && error.message === '您没有该组织的管理权限'
  );
  await assert.rejects(
    () => requireAdminOrganizationPermission(req, 'org-denied', ['hr.people']),
    (error) => error instanceof AdminOrganizationAccessError && error.code === 'organization_forbidden'
  );
  await assert.rejects(
    () => requireAdminOrganizationPermission(req, '', ['hr.people']),
    (error) => error instanceof AdminOrganizationAccessError && error.code === 'invalid_organization'
  );
  for (const openid of ['', 'another-admin-wechat']) {
    const result = await requireAdminOrganizationPermission(Object.assign({}, req, { openid }), 'org-44', ['system.admin_accounts.write']);
    assert.strictEqual(result.admin.id, allowed.admin.id, '管理授权不得因当前微信改变');
  }
  await assert.rejects(
    () => requireAdminOrganizationPermission({ openid: 'openid-1' }, 'org-44', ['hr.people']),
    error => error.code === 'organization_forbidden'
  );

  console.log('管理员跨组织权限推导与目标组织写入验权测试通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
