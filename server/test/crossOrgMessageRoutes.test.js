const assert = require('assert');
const { AsyncLocalStorage } = require('async_hooks');

const orgContextPath = require.resolve('../src/utils/orgContext');
const accessiblePath = require.resolve('../src/core/services/accessibleOrganizations');
const notificationModelPath = require.resolve('../src/modules/audit/models/notification');
const todoServicePath = require.resolve('../src/modules/audit/services/todoService');
const unifiedIdentityPath = require.resolve('../src/core/models/unifiedIdentity');
const routePath = require.resolve('../src/modules/audit/routes/notification');

const contexts = [
  {
    organizationId: 'org-a',
    organizationName: '甲组织',
    isCurrentOrganization: true,
    actor: { type: 'user', id: 'hr-a', openid: 'openid-1', profile: { id: 'hr-a' } }
  },
  {
    organizationId: 'org-b',
    organizationName: '乙组织',
    isCurrentOrganization: false,
    actor: { type: 'user', id: 'hr-b', openid: 'openid-1', profile: { id: 'hr-b' } }
  }
];

let failTodoOrgId = '';
let targetedMutationMode = '';
const todoCalls = [];
const notificationCalls = [];
const markAllCalls = [];
let notificationTargetType = 'account';
const testOrgStorage = new AsyncLocalStorage();

const todoService = {
  compareTodo(left, right) {
    const leftTime = left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const rightTime = right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.id).localeCompare(String(right.id));
  },
  async listAll(actor, orgId) {
    todoCalls.push({ actorId: actor.id, orgId, activeOrgId: testOrgStorage.getStore() });
    if (orgId === failTodoOrgId) throw new Error('模拟组织查询失败');
    return [{
      id: 'todo-' + orgId,
      title: orgId,
      dueAt: orgId === 'org-b' ? '2026-07-26 09:00:00' : '2026-07-27 09:00:00',
      createdAt: '2026-07-25 09:00:00'
    }];
  }
};

const notificationModel = {
  async listForRecipient(actor) {
    notificationCalls.push(actor.id);
    const isSecondOrg = actor.id === 'hr-b';
    return {
      items: [{
        id: isSecondOrg ? 'notice-b' : 'notice-a',
        type: 'system',
        title: isSecondOrg ? '乙通知' : '甲通知',
        category: 'system',
        target_type: notificationTargetType,
        target_id: '',
        target_url: 'https://untrusted.example/should-never-be-used',
        is_read: isSecondOrg ? 0 : 1,
        created_at: isSecondOrg ? '2026-07-26 10:00:00' : '2026-07-25 10:00:00'
      }],
      total: 1,
      unreadCount: isSecondOrg ? 1 : 0
    };
  },
  async markAllRead(actor) {
    markAllCalls.push(actor.id);
    return { changedCount: 1, unreadCount: 0 };
  },
  async markRead(id, actor) {
    if (targetedMutationMode === 'partial') {
      if (actor.id === 'hr-secondary') throw new Error('模拟岗位查询失败');
      return { found: false, changed: false, unreadCount: 1 };
    }
    return { found: true, changed: true, unreadCount: 0 };
  },
  async deleteById(id, actor) {
    if (targetedMutationMode === 'partial') {
      if (actor.id === 'hr-secondary') throw new Error('模拟岗位查询失败');
      return { found: false, unreadCount: 1 };
    }
    return { found: true, unreadCount: 0 };
  }
};

require.cache[orgContextPath] = {
  id: orgContextPath,
  filename: orgContextPath,
  loaded: true,
  exports: {
    getCurrentOrgId: async function() { return 'org-a'; },
    orgStorage: testOrgStorage
  }
};
require.cache[accessiblePath] = {
  id: accessiblePath,
  filename: accessiblePath,
  loaded: true,
  exports: {
    listAccessibleActorContexts: async function() { return contexts; }
  }
};
require.cache[notificationModelPath] = {
  id: notificationModelPath,
  filename: notificationModelPath,
  loaded: true,
  exports: notificationModel
};
require.cache[todoServicePath] = {
  id: todoServicePath,
  filename: todoServicePath,
  loaded: true,
  exports: todoService
};
require.cache[unifiedIdentityPath] = {
  id: unifiedIdentityPath,
  filename: unifiedIdentityPath,
  loaded: true,
  exports: {
    async listContexts() { return []; }
  }
};
delete require.cache[routePath];
const router = require(routePath);

function getHandler(path) {
  const layer = router.stack.find((item) => item.route && item.route.path === path);
  assert(layer, '缺少路由：' + path);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(path, body, role) {
  let payload = null;
  await getHandler(path)(
    {
      body: body || {},
      openid: 'openid-1',
      authAccount: { id: 'account-1', personId: 'person-1' },
      authContext: { role: role || 'user', contextId: 'context-1', personId: 'person-1', organizationId: 'org-a' },
      headers: { 'x-role': role || 'user' }
    },
    {
      json(value) {
        payload = value;
        return value;
      }
    }
  );
  return payload;
}

async function testGlobalTodoAggregationAndMetadata() {
  todoCalls.length = 0;
  failTodoOrgId = '';
  const result = await invoke('/listTodos', { limit: 20 });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.total, 2);
  assert.deepStrictEqual(result.items.map((item) => item.id), ['todo-org-b', 'todo-org-a']);
  assert.deepStrictEqual(
    result.items.map((item) => item.organizationName),
    ['乙组织', '甲组织']
  );
  assert.strictEqual(result.items[1].isCurrentOrganization, true);
  assert.strictEqual(result.organizations.length, 2);
  assert.ok(todoCalls.every((call) => call.orgId === call.activeOrgId), '每个跨组织待办查询必须进入对应 ALS 组织上下文');
}

async function testOrganizationFilterAndDenial() {
  todoCalls.length = 0;
  const filtered = await invoke('/listTodos', { limit: 20, organizationId: 'org-b' });
  assert.strictEqual(filtered.status, 'success');
  assert.deepStrictEqual(todoCalls, [{ actorId: 'hr-b', orgId: 'org-b', activeOrgId: 'org-b' }]);
  const denied = await invoke('/listTodos', { organizationId: 'org-x' });
  assert.strictEqual(denied.status, 'org_access_denied');
  assert.strictEqual(todoCalls.length, 1, '越权筛选不得执行待办查询');
}

async function testPartialFailure() {
  failTodoOrgId = 'org-b';
  const result = await invoke('/listTodos', { limit: 20 });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.partial, true);
  assert.strictEqual(result.total, 1);
  assert.deepStrictEqual(result.failedOrganizations, [{
    organizationId: 'org-b',
    organizationName: '乙组织'
  }]);
  failTodoOrgId = '';
}

async function testNotificationOrderAndCounts() {
  notificationCalls.length = 0;
  const result = await invoke('/listNotifications', { limit: 20 });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.unreadCount, 1);
  assert.deepStrictEqual(result.items.map((item) => item.id), ['notice-b', 'notice-a']);
  assert.deepStrictEqual(notificationCalls.sort(), ['hr-a', 'hr-b']);
  assert.strictEqual(result.items[0].organizationId, 'org-b');
  assert.strictEqual(
    result.items[0].targetUrl,
    '/subpackages/main/pages/portal/portal',
    '消息跳转必须由服务端白名单映射，不能采用数据库中保存的任意地址'
  );
}

async function testMarkAllScope() {
  markAllCalls.length = 0;
  const filtered = await invoke('/markAllNotificationsRead', { organizationId: 'org-b' });
  assert.strictEqual(filtered.status, 'success');
  assert.deepStrictEqual(markAllCalls, ['hr-b']);
  markAllCalls.length = 0;
  const global = await invoke('/markAllNotificationsRead', {});
  assert.strictEqual(global.changedCount, 2);
  assert.deepStrictEqual(markAllCalls.sort(), ['hr-a', 'hr-b']);
}

async function testHrProfileNotificationUsesAdminPage() {
  const originalContexts = contexts.slice();
  notificationTargetType = 'hr_profile';
  contexts.splice(0, contexts.length, {
    organizationId: 'org-a',
    organizationName: '甲组织',
    isCurrentOrganization: true,
    actor: { type: 'admin', id: 'admin-a', openid: 'openid-1', profile: { id: 'admin-a' } }
  });
  try {
    const result = await invoke('/listNotifications', { limit: 20 }, 'admin');
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(
      result.items[0].targetUrl,
      '/subpackages/scoring/pages/admin/admin?subApp=hr&tab=hrInfo'
    );
  } finally {
    notificationTargetType = 'account';
    contexts.splice(0, contexts.length, ...originalContexts);
  }
}

async function testTargetedMutationDoesNotMisreportNotFoundOnPartialFailure() {
  const originalContexts = contexts.slice();
  contexts.splice(0, contexts.length,
    {
      organizationId: 'org-a',
      organizationName: '甲组织',
      isCurrentOrganization: true,
      actor: { type: 'user', id: 'hr-a', openid: 'openid-1', profile: { id: 'hr-a' } }
    },
    {
      organizationId: 'org-a',
      organizationName: '甲组织',
      isCurrentOrganization: true,
      actor: { type: 'user', id: 'hr-secondary', openid: 'openid-1', profile: { id: 'hr-secondary' } }
    }
  );
  targetedMutationMode = 'partial';
  try {
    const marked = await invoke('/markNotificationRead', { id: 'notice-unknown' });
    assert.strictEqual(marked.status, 'error');
    assert.strictEqual(marked.partial, true);
    assert.deepStrictEqual(marked.failedOrganizations, [{
      organizationId: 'org-a',
      organizationName: '甲组织'
    }]);

    const deleted = await invoke('/deleteNotification', { id: 'notice-unknown' });
    assert.strictEqual(deleted.status, 'error');
    assert.strictEqual(deleted.partial, true);
    assert.notStrictEqual(deleted.status, 'not_found');
  } finally {
    targetedMutationMode = '';
    contexts.splice(0, contexts.length, ...originalContexts);
  }
}

(async function run() {
  await testGlobalTodoAggregationAndMetadata();
  await testOrganizationFilterAndDenial();
  await testPartialFailure();
  await testNotificationOrderAndCounts();
  await testMarkAllScope();
  await testHrProfileNotificationUsesAdminPage();
  await testTargetedMutationDoesNotMisreportNotFoundOnPartialFailure();
  console.log('跨组织消息路由聚合、筛选、部分失败与写入作用域测试通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
