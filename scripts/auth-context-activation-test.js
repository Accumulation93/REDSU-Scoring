const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const storage = {};
const events = [];
let activationResult = null;
let callFunctionHandler = function() { return Promise.resolve(activationResult); };

global.wx = {
  getStorageSync(key) { return storage[key]; },
  setStorageSync(key, value) { storage[key] = value; },
  removeStorageSync(key) { delete storage[key]; },
  setStorage(options) {
    storage[options.key] = options.data;
    if (typeof options.success === 'function') options.success();
  }
};

const apiPath = path.resolve(__dirname, '..', 'miniprogram', 'utils', 'api.js');
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    callFunction(options) { return callFunctionHandler(options); },
    markAuthenticationReady() {},
    beginContextActivation() {},
    endContextActivation() {}
  }
};

const eventBusPath = path.resolve(__dirname, '..', 'miniprogram', 'utils', 'eventBus.js');
require.cache[eventBusPath] = {
  id: eventBusPath,
  filename: eventBusPath,
  loaded: true,
  exports: {
    emit(name, payload) { events.push({ name, payload }); }
  }
};

const authContext = require('../miniprogram/utils/authContext');
const orgSession = require('../miniprogram/utils/orgSession');

const userContext = {
  contextId: 'ctx-user-existing',
  role: 'user',
  organizationId: 'org-existing',
  organizationName: '既有组织',
  assignmentId: 'assignment-existing'
};
const adminContext = {
  contextId: 'ctx-admin-test',
  role: 'admin',
  organizationId: 'org-test',
  organizationName: '测试组织',
  adminGrantId: 'grant-global',
  adminLevel: 'super_admin',
  permissions: ['*']
};

test('切换到新组织超级管理员后原子替换运行时权限并阻止旧登录回写', async () => {
  authContext.applyAuthenticatedResult({
    status: 'login_success',
    token: 'token-user',
    selectionNotice: '旧服务端岗位提示',
    account: { id: 'account-1', personId: 'person-1', name: '测试管理员', studentId: '20260001' },
    context: userContext,
    contexts: [userContext, adminContext],
    workContexts: [userContext, adminContext],
    organizations: [
      { id: 'org-existing', name: '既有组织', roles: ['user'] },
      { id: 'org-test', name: '测试组织', roles: ['admin'] }
    ],
    selection: { organizationId: 'org-existing', contextId: 'ctx-user-existing' },
    user: { id: 'hr-1', name: '测试管理员', assignmentId: 'assignment-existing' }
  });

  activationResult = {
    status: 'success',
    token: 'token-admin',
    context: adminContext,
    contexts: [userContext, adminContext],
    workContexts: [userContext, adminContext],
    organizations: [
      { id: 'org-existing', name: '既有组织', roles: ['user'] },
      { id: 'org-test', name: '测试组织', roles: ['admin'] }
    ],
    identities: [],
    selection: { organizationId: 'org-test', contextId: 'ctx-admin-test' },
    user: {
      id: 'admin-1',
      name: '测试管理员',
      adminLevel: 'super_admin',
      permissions: ['*']
    }
  };

  const activated = await authContext.activateContext('ctx-admin-test');
  assert.equal(activated.context.role, 'admin');
  assert.equal(activated.user.adminLevel, 'super_admin');
  assert.equal(activated.user.permissions['*'], true);
  assert.equal(authContext.getRuntimeProfile('user'), null);
  assert.equal(authContext.getRuntimeProfile('admin').permissions['*'], true);
  assert.deepEqual(orgSession.getSnapshot(), {
    token: 'token-admin',
    role: 'admin',
    contextId: 'ctx-admin-test',
    orgId: 'org-test',
    orgName: '测试组织',
    identityId: '',
    version: activated.version
  });

  await new Promise(function(resolve) { setTimeout(resolve, 900); });
  assert.equal(storage.activeRole, 'admin');
  assert.equal(storage.activeContextId, 'ctx-admin-test');
  assert.equal(storage.token, 'token-admin');
  assert.equal(storage.roleProfiles.admin.adminLevel, 'super_admin');
  assert.equal(storage.roleProfiles.admin.permissions['*'], true);
  assert.equal(storage.authSession.authState.context.contextId, 'ctx-admin-test');
  assert.equal(storage.authSelectionNotice, undefined, '旧服务端提示不得写入兼容缓存');
  assert(events.some(function(item) { return item.name === 'auth:contextChanged'; }));
  assert(events.some(function(item) { return item.name === 'org:changed'; }));
});

test('旧组织权限响应不得覆盖刚切换的新组织超级管理员', async () => {
  const adminPermissions = require('../miniprogram/utils/adminPermissions');
  let resolveOldPermissionRequest;
  callFunctionHandler = function(options) {
    if (options.name === 'getMyAdminPermissions') {
      return new Promise(function(resolve) { resolveOldPermissionRequest = resolve; });
    }
    return Promise.resolve(activationResult);
  };
  const oldRequest = adminPermissions.refreshMyPermissions();

  const nextAdminContext = Object.assign({}, adminContext, {
    contextId: 'ctx-admin-43',
    organizationId: 'org-43',
    organizationName: '第四十三届学生会'
  });
  activationResult = {
    status: 'success',
    token: 'token-admin-43',
    context: nextAdminContext,
    contexts: [nextAdminContext],
    workContexts: [nextAdminContext],
    organizations: [{ id: 'org-43', name: '第四十三届学生会', roles: ['admin'] }],
    identities: [],
    selection: { organizationId: 'org-43', contextId: 'ctx-admin-43' },
    user: {
      id: 'admin-1',
      name: '测试管理员',
      adminLevel: 'super_admin',
      permissions: ['*']
    }
  };
  callFunctionHandler = function() { return Promise.resolve(activationResult); };
  await authContext.activateContext('ctx-admin-43');
  resolveOldPermissionRequest({
    status: 'success',
    organizationId: 'org-test',
    adminLevel: 'admin',
    permissions: {},
    permissionKeys: []
  });

  assert.equal(await oldRequest, null);
  assert.equal(authContext.getRuntimeProfile('admin').adminLevel, 'super_admin');
  assert.equal(authContext.getRuntimeProfile('admin').permissions['*'], true);
  assert.equal(orgSession.getSnapshot().orgId, 'org-43');
});

test('旧岗位目录响应不得覆盖当前组织目录', async () => {
  let resolveOldCatalog;
  callFunctionHandler = function(options) {
    if (options.name === 'auth/contexts') {
      return new Promise(function(resolve) { resolveOldCatalog = resolve; });
    }
    return Promise.resolve(activationResult);
  };
  const oldCatalogRequest = authContext.refreshCatalog();

  const finalContext = Object.assign({}, adminContext, {
    contextId: 'ctx-admin-final',
    organizationId: 'org-final',
    organizationName: '当前组织'
  });
  activationResult = {
    status: 'success',
    token: 'token-admin-final',
    context: finalContext,
    contexts: [finalContext],
    workContexts: [finalContext],
    organizations: [{ id: 'org-final', name: '当前组织', roles: ['admin'] }],
    identities: [],
    selection: { organizationId: 'org-final', contextId: 'ctx-admin-final' },
    user: { id: 'admin-1', name: '测试管理员', adminLevel: 'super_admin', permissions: ['*'] }
  };
  callFunctionHandler = function() { return Promise.resolve(activationResult); };
  await authContext.activateContext('ctx-admin-final');
  resolveOldCatalog({
    status: 'success',
    currentContextId: 'ctx-admin-43',
    contexts: [],
    workContexts: [],
    organizations: [],
    identities: [],
    selection: { organizationId: 'org-43', contextId: 'ctx-admin-43' }
  });

  await assert.rejects(oldCatalogRequest, function(error) { return error.status === 'stale_context'; });
  assert.equal(authContext.getContexts()[0].contextId, 'ctx-admin-final');
  assert.equal(orgSession.getSnapshot().orgId, 'org-final');
});

test('登录兼容旧服务端时忽略岗位提示，退出时清理历史缓存', async () => {
  storage.authSelectionNotice = '历史缓存提示';
  authContext.applyAuthenticatedResult(Object.assign({}, activationResult, {
    status: 'login_success', selectionNotice: '旧服务端岗位提示'
  }));
  await new Promise(function(resolve) { setTimeout(resolve, 900); });
  assert.equal(storage.authSelectionNotice, '历史缓存提示', '登录不再写入通知键');
  assert.equal(orgSession.getSnapshot().orgId, 'org-final', '移除提示不改变有效组织');
  authContext.clearUnifiedAuthentication();
  assert.equal(storage.authSelectionNotice, undefined, '正常退出一并清理旧通知键');
});
