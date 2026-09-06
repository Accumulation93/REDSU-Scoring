const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.AUTH_IDENTITY_SECRET = process.env.AUTH_IDENTITY_SECRET || 'message-center-identity-test-secret-32-bytes';

const root = path.join(__dirname, '..');

function flattenLocale(locale, prefix, output) {
  const result = output || {};
  for (const [key, value] of Object.entries(locale || {})) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenLocale(value, nextKey, result);
    } else if (typeof value === 'string') {
      result[nextKey] = value;
    }
  }
  return result;
}

function hydrateLocale(source, locale, variableName, asLiteral) {
  return Object.entries(flattenLocale(locale)).reduce((result, entry) => {
    const escapedKey = entry[0].replace(/\./g, '\\.');
    const pattern = new RegExp(`\\b${variableName}\\.${escapedKey}\\b`, 'g');
    return result.replace(pattern, asLiteral ? JSON.stringify(entry[1]) : entry[1]);
  }, source);
}
const dbPath = require.resolve('../src/config/db');
const orgPath = require.resolve('../src/utils/orgContext');
const notificationPath = require.resolve('../src/modules/audit/models/notification');
const accessibleOrganizationsPath = require.resolve('../src/core/services/accessibleOrganizations');
const organizationModelPath = require.resolve('../src/core/models/organization');

const calls = [];
const responses = [];
const mockPool = {
  async query(sql, params) {
    calls.push({ sql: String(sql), params });
    if (!responses.length) throw new Error('缺少模拟查询响应');
    return responses.shift();
  }
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockPool };
require.cache[orgPath] = {
  id: orgPath,
  filename: orgPath,
  loaded: true,
  exports: { getCurrentOrgId: async function() { return 'org-44'; } }
};
delete require.cache[notificationPath];
const notificationModel = require(notificationPath);

async function testNotificationIsolationAndAwait() {
  calls.length = 0;
  responses.push([[{ total: 2, unread_count: 1 }], []]);
  responses.push([[{ id: 'notice-1', is_read: 0 }], []]);
  const result = await notificationModel.listForRecipient({ type: 'admin', id: 'admin-1' }, { limit: 20 });
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.unreadCount, 1);
  assert.strictEqual(result.items.length, 1);
  assert.deepStrictEqual(calls[0].params.slice(0, 3), ['org-44', 'admin', 'admin-1']);
  assert.ok(!calls[0].params.some((value) => value && typeof value.then === 'function'), 'SQL 参数中不得出现 Promise');
}

async function testReadAffectedRowsContract() {
  calls.length = 0;
  responses.push([{ affectedRows: 0 }, []]);
  responses.push([[], []]);
  const missing = await notificationModel.markRead('foreign-id', { type: 'user', id: 'hr-1' });
  assert.deepStrictEqual(missing, { found: false, changed: false, unreadCount: null });
  assert.deepStrictEqual(calls[0].params, ['foreign-id', 'org-44', 'user', 'hr-1']);
}

async function testNotificationKeysetBoundary() {
  calls.length = 0;
  responses.length = 0;
  responses.push([[{ total: 3, unread_count: 2 }], []]);
  responses.push([[{ id: 'notice-older', created_at: '2026-07-27 09:00:00' }], []]);
  const result = await notificationModel.listForRecipient(
    { type: 'user', id: 'hr-1' },
    {
      limit: 21,
      maxLimit: 21,
      beforeCreatedAt: '2026-07-28T01:00:00.000Z',
      beforeId: 'f'.repeat(64)
    }
  );
  assert.strictEqual(result.items.length, 1);
  assert.match(calls[1].sql, /created_at < \?[\s\S]*id < \?/);
  assert.strictEqual(calls[1].params[calls[1].params.length - 2], 'f'.repeat(64));
  assert.strictEqual(calls[1].params[calls[1].params.length - 1], 21);
  assert.ok(calls[1].params[calls[1].params.length - 4] instanceof Date);
}

function authenticatedRequest(role, organizationId) {
  return {
    openid: 'wechat-of-another-person',
    authAccount: { id: 'account-one', personId: 'person-one' },
    authContext: { contextId: 'context-current', personId: 'person-one', role, organizationId }
  };
}

async function testCrossOrganizationActorResolution() {
  calls.length = 0;
  responses.length = 0;
  responses.push([['a', 'b'].map((suffix) => ({
    assignment_id: 'assignment-' + suffix, membership_id: 'membership-' + suffix,
    legacy_hr_id: 'hr-' + suffix, person_id: 'person-one', person_name: '张三',
    organization_id: 'org-' + suffix, organization_name: suffix,
    department_id: 'dept-' + suffix, identity_id: 'identity-' + suffix,
    work_group_id: '', assignment_kind: 'staff'
  })), []]);
  responses.push([[], []], [[], []]);
  delete require.cache[accessibleOrganizationsPath];
  const accessibleOrganizations = require(accessibleOrganizationsPath);
  const contexts = await accessibleOrganizations.listAccessibleActorContexts(authenticatedRequest('user', 'org-a'), 'user');
  assert.deepStrictEqual(contexts.map((item) => item.organizationId), ['org-a', 'org-b']);
  assert.deepStrictEqual(contexts.map((item) => item.actor.id), ['hr-a', 'hr-b']);
  assert.strictEqual(contexts[0].isCurrentOrganization, true);
  assert.strictEqual(contexts[1].actor.userInfoId, undefined, '组织目录不得伪造微信绑定');
  assert(calls.every((call) => call.params[0] === 'account-one'));
  assert(calls.every((call) => !/openid|user_info|admin_info/.test(call.sql)), '只能按统一账号查询自然人的组织与岗位');
  assert(!calls.some((call) => /^\s*(INSERT|UPDATE)/i.test(call.sql)), '聚合查询不得创建或更新绑定');
}

async function testAdminActorResolution() {
  calls.length = 0;
  responses.length = 0;
  responses.push([[], []], [[], []]);
  responses.push([['a', 'b'].map((suffix) => ({
    admin_grant_id: 'grant-super', legacy_admin_id: 'super-1', grant_org_id: '',
    admin_level: 'super_admin', person_id: 'person-one', person_name: '超级管理员',
    organization_id: 'org-' + suffix, organization_name: suffix
  })), []]);
  const accessibleOrganizations = require(accessibleOrganizationsPath);
  const contexts = await accessibleOrganizations.listAccessibleActorContexts(authenticatedRequest('admin', 'org-b'), 'admin');
  assert.deepStrictEqual(contexts.map((item) => item.organizationId), ['org-a', 'org-b']);
  assert(contexts.every((item) => item.actor.type === 'admin' && item.actor.id === 'super-1'));
  assert.strictEqual(contexts[1].isCurrentOrganization, true);
  assert(calls.every((call) => call.params[0] === 'account-one'));
  assert(calls.every((call) => !/openid|user_info|admin_info/.test(call.sql)));
}

function testMigrationAndFrontendContract() {
  const migration = fs.readFileSync(path.join(root, 'db/migrate_message_center.sql'), 'utf8');
  assert.match(migration, /notification_outbox/);
  assert.match(migration, /recipient_type/);
  assert.match(migration, /notification_pending_approval_archive/);
  assert.match(migration, /DELETE FROM notifications WHERE type = 'pending_approval'/);
  assert.match(migration, /approval_mode/);
  assert.match(migration, /SIGNAL SQLSTATE '45000'/);

  const mainCopy = require('../../miniprogram/locales/zh-CN/main');
  const portal = hydrateLocale(
    fs.readFileSync(path.join(root, '../miniprogram/subpackages/main/pages/portal/portal.js'), 'utf8'),
    mainCopy.portal,
    'copy',
    true
  );
  assert.match(portal, /getMessageOverview/);
  assert.match(portal, /markAllNotificationsRead/);
  assert.match(portal, /limit: 6/);
  assert.match(portal, /activateOrganization/);
  assert.match(portal, /if \(this\._messageOverviewLoading\)[\s\S]*this\._messageOverviewQueued = true/);
  assert.match(portal, /shouldReload && this\._isPageVisible && this\.data\.hasUser/);
  assert.strictEqual(
    (portal.match(/key:\s*['"]messages['"],\s*label:\s*['"]消息中心['"],\s*iconName:\s*['"]bell['"],\s*url:\s*['"]\/subpackages\/message\/pages\/messageCenter\/messageCenter['"]/g) || []).length,
    2,
    '普通用户端和管理端应用服务都必须包含消息中心'
  );
  assert.doesNotMatch(portal, /loadNotificationUnreadCount/);
  const adminPermissions = fs.readFileSync(path.join(root, '../miniprogram/utils/adminPermissions.js'), 'utf8');
  assert.match(adminPermissions, /card\.key === 'messages'[\s\S]*return true/);
  const portalView = hydrateLocale(
    fs.readFileSync(path.join(root, '../miniprogram/subpackages/main/pages/portal/portal.wxml'), 'utf8'),
    mainCopy.portal.view,
    'copy',
    false
  );
  assert.match(portalView, /portal-organization-meta/);
  assert.match(portalView, /\{\{messageSwitchTitle\}\}/);
  assert.match(portalView, /切换并查看/);
  assert.doesNotMatch(portalView, /length \* 102/);
  const portalStyle = fs.readFileSync(path.join(root, '../miniprogram/subpackages/main/pages/portal/portal.wxss'), 'utf8');
  assert.match(
    portalStyle,
    /\.message-preview-scroll[\s\S]*max-height: calc\(var\(--ui-message-preview-row, 154rpx\) \* 3 \+ var\(--ui-message-preview-gap, 8rpx\) \* 2\)/
  );

  const messageCenter = fs.readFileSync(path.join(root, '../miniprogram/subpackages/message/pages/messageCenter/messageCenter.js'), 'utf8');
  const messageCenterView = hydrateLocale(
    fs.readFileSync(path.join(root, '../miniprogram/subpackages/message/pages/messageCenter/messageCenter.wxml'), 'utf8'),
    mainCopy.messageCenter.view,
    'copy',
    false
  );
  const messageCenterStyle = fs.readFileSync(path.join(root, '../miniprogram/subpackages/message/pages/messageCenter/messageCenter.wxss'), 'utf8');
  assert.match(messageCenter, /messageScope/);
  assert.match(messageCenter, /organizationId/);
  assert.match(messageCenterView, /organization-filter/);
  assert.match(messageCenterView, /organization-meta-name/);
  assert.match(messageCenterView, /部分组织暂未加载/);
  assert.match(messageCenterStyle, /\.message-switch-mask[\s\S]*background:\s*rgba\(15,\s*23,\s*42,\s*0\.34\)/);
  assert.match(messageCenterStyle, /\.message-switch-dialog[\s\S]*background:\s*linear-gradient\(145deg/);
  assert.match(messageCenterStyle, /\.message-switch-dialog[\s\S]*box-shadow:/);

  const notificationRoute = fs.readFileSync(
    path.join(root, 'src/modules/audit/routes/notification.js'),
    'utf8'
  );
  assert.doesNotMatch(notificationRoute, /localeCompare/);
  assert.match(notificationRoute, /String\(left\.id \|\| ''\)\.toLowerCase\(\)/);
}

(async function run() {
  await testNotificationIsolationAndAwait();
  await testReadAffectedRowsContract();
  await testNotificationKeysetBoundary();
  await testCrossOrganizationActorResolution();
  await testAdminActorResolution();
  testMigrationAndFrontendContract();
  console.log('跨组织消息中心隔离、身份解析、销记和前端契约测试通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
