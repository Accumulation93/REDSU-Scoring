'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '../..');
const locale = require('../../miniprogram/locales/zh-CN/main');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createOverview(notificationItems, options) {
  const settings = options || {};
  return {
    status: 'success',
    organizations: [],
    todos: { items: [], total: 0, nextCursor: '' },
    notifications: {
      items: notificationItems,
      total: settings.total === undefined ? notificationItems.length : settings.total,
      unreadCount: settings.unreadCount === undefined
        ? notificationItems.filter((item) => !item.isRead).length
        : settings.unreadCount,
      nextCursor: ''
    },
    partial: !!settings.partial,
    failedOrganizations: settings.failedOrganizations || []
  };
}

function loadPage(relativePath, responseQueues, runtimeOptions) {
  const runtime = runtimeOptions || {};
  const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
  const calls = [];
  const toasts = [];
  const modals = [];
  const storage = new Map();
  let definition = null;

  const api = {
    async callFunction(options) {
      calls.push(options.name);
      const queue = responseQueues[options.name] || [];
      assert.ok(queue.length, `缺少 ${options.name} 的模拟响应`);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return clone(next);
    },
    formatAuditTime(value) {
      return value || '';
    },
    showShortToast(message) {
      toasts.push(message);
    }
  };
  const orgSession = {
    beginRequest() { return {}; },
    isRequestCurrent() { return true; },
    getSnapshot() { return { orgId: 'org-a', contextId: '', role: 'user' }; },
    consume() { return { changed: false }; },
    invalidateRequests() {},
    commitContext() {}
  };
  const mocks = {
    '../../../../utils/api': api,
    '../../../../utils/orgSession': orgSession,
    // 本组仅验证消息批量操作；可选绑定的生命周期在专项测试中覆盖。
    '../../../../utils/passwordBindingOffer': { start() {}, cancel() {} },
    '../../../../utils/messageScope': {
      getScope() { return { organizationId: '', organizationName: locale.messageCenter.messages.allOrganizations }; },
      setScope() {},
      resetScope() {}
    },
    '../../../../utils/organizationActivation': { activateOrganization: async function() { return {}; } },
    '../../../../utils/authContext': {
      clearUnifiedAuthentication() {},
      normalizeProfile(value) { return value; },
      resolveContextId() { return ''; }
    },
    '../../../../utils/notificationNavigationReceipt': { stage() { return true; }, clear() {}, take() { return null; } },
    '../../../../utils/trustedNavigation': {
      navigateToTrustedRoute(url, handlers) {
        if (runtime.navigationSucceeds === false) {
          if (handlers && handlers.fail) handlers.fail({ errMsg: 'navigateTo:fail' });
          return false;
        }
        if (handlers && handlers.success) handlers.success({ errMsg: 'navigateTo:ok' });
        return true;
      },
      reLaunchPortalThenNavigate() { return true; },
      reLaunchTrustedRoute() { return true; },
      isTrustedRoute() { return true; }
    },
    '../../../../utils/eventBus': { on() {}, off() {} },
    '../../../../utils/adminPermissions': {
      filterPortalCards(cards) { return cards; },
      refreshMyPermissions: async function() {}
    },
    '../../../../utils/portalExit': { shouldClearAuthenticationOnPortalExit() { return false; } },
    '../../../../locales/zh-CN/main': locale
  };
  const wx = {
    getStorageSync(key) {
      if (runtime.storageThrows) throw new Error('storage unavailable');
      return storage.get(key) || '';
    },
    setStorageSync(key, value) {
      if (runtime.storageThrows) throw new Error('storage unavailable');
      storage.set(key, value);
    },
    removeStorageSync(key) { storage.delete(key); },
    setNavigationBarTitle() {},
    showModal(options) { modals.push(options); },
    reLaunch() {}
  };
  const sandbox = {
    require(request) {
      assert.ok(Object.prototype.hasOwnProperty.call(mocks, request), `未模拟依赖：${request}`);
      return mocks[request];
    },
    Page(value) { definition = value; },
    wx,
    console,
    setInterval,
    clearInterval,
    getCurrentPages() { return []; }
  };
  vm.runInNewContext(source, sandbox, { filename: relativePath });
  assert.ok(definition, `${relativePath} 必须注册 Page`);
  const page = Object.assign({}, definition);
  page.data = clone(definition.data);
  page.setData = function(patch) {
    Object.assign(this.data, patch);
  };
  return { page, calls, toasts, modals };
}

function seedNotifications(page) {
  page.data.notifications = [{ id: 'notice-before', isRead: false }];
  page.data.notificationTotal = 1;
  page.data.unreadCount = 1;
  page.data.notificationCount = 1;
  page.data.partial = false;
  page.data.messagePartial = false;
}

async function testMessageCenterMarkAllPartialRefreshesTruth() {
  const harness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    {
      markAllNotificationsRead: [{
        status: 'success',
        partial: false,
        failedOrganizations: [{ organizationId: 'org-b', organizationName: '乙组织' }]
      }],
      getMessageOverview: [createOverview([{ id: 'notice-real', isRead: false }])]
    }
  );
  seedNotifications(harness.page);

  await harness.page.markAllRead();

  assert.deepStrictEqual(harness.calls, ['markAllNotificationsRead', 'getMessageOverview']);
  assert.strictEqual(harness.page.data.unreadCount, 1);
  assert.strictEqual(harness.page.data.notifications[0].id, 'notice-real');
  assert.strictEqual(harness.page.data.notifications[0].isRead, false);
  assert.deepStrictEqual(harness.toasts, [locale.messageCenter.messages.partialBulkAction]);
}

async function testMessageCenterMarkAllSuccessKeepsOptimisticResult() {
  const harness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    { markAllNotificationsRead: [{ status: 'success', partial: false, failedOrganizations: [] }] }
  );
  seedNotifications(harness.page);

  await harness.page.markAllRead();

  assert.deepStrictEqual(harness.calls, ['markAllNotificationsRead']);
  assert.strictEqual(harness.page.data.unreadCount, 0);
  assert.strictEqual(harness.page.data.notifications[0].isRead, true);
  assert.deepStrictEqual(harness.toasts, []);
}

async function testMessageCenterMarkAllFailureRollsBackAndRefreshes() {
  const harness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    {
      markAllNotificationsRead: [new Error('network')],
      getMessageOverview: [createOverview([{ id: 'notice-after-failure', isRead: false }])]
    }
  );
  seedNotifications(harness.page);

  await harness.page.markAllRead();

  assert.deepStrictEqual(harness.calls, ['markAllNotificationsRead', 'getMessageOverview']);
  assert.strictEqual(harness.page.data.unreadCount, 1);
  assert.strictEqual(harness.page.data.notifications[0].id, 'notice-after-failure');
  assert.deepStrictEqual(harness.toasts, [locale.messageCenter.messages.incomplete]);
}

async function testMessageCenterClearPartialRefreshesTruth() {
  const harness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    {
      deleteAllNotifications: [{ status: 'success', partial: true }],
      getMessageOverview: [createOverview([{ id: 'notice-not-deleted', isRead: true }], { unreadCount: 0 })]
    }
  );
  seedNotifications(harness.page);

  harness.page.deleteAllNotifications();
  assert.strictEqual(harness.modals.length, 1);
  await harness.modals[0].success({ confirm: true });

  assert.deepStrictEqual(harness.calls, ['deleteAllNotifications', 'getMessageOverview']);
  assert.strictEqual(harness.page.data.notificationTotal, 1);
  assert.strictEqual(harness.page.data.notifications[0].id, 'notice-not-deleted');
  assert.deepStrictEqual(harness.toasts, [locale.messageCenter.messages.partialBulkAction]);
}

async function testMessageCenterClearSuccessKeepsOptimisticResult() {
  const harness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    { deleteAllNotifications: [{ status: 'success', partial: false, failedOrganizations: [] }] }
  );
  seedNotifications(harness.page);

  harness.page.deleteAllNotifications();
  await harness.modals[0].success({ confirm: true });

  assert.deepStrictEqual(harness.calls, ['deleteAllNotifications']);
  assert.strictEqual(harness.page.data.notificationTotal, 0);
  assert.strictEqual(harness.page.data.unreadCount, 0);
  assert.strictEqual(harness.page.data.notifications.length, 0);
  assert.deepStrictEqual(harness.toasts, []);
}

async function testMessageCenterClearFailureRollsBackAndRefreshes() {
  const harness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    {
      deleteAllNotifications: [{ status: 'error', message: 'failed' }],
      getMessageOverview: [createOverview([{ id: 'notice-after-clear-failure', isRead: false }])]
    }
  );
  seedNotifications(harness.page);

  harness.page.deleteAllNotifications();
  await harness.modals[0].success({ confirm: true });

  assert.deepStrictEqual(harness.calls, ['deleteAllNotifications', 'getMessageOverview']);
  assert.strictEqual(harness.page.data.notificationTotal, 1);
  assert.strictEqual(harness.page.data.unreadCount, 1);
  assert.strictEqual(harness.page.data.notifications[0].id, 'notice-after-clear-failure');
  assert.deepStrictEqual(harness.toasts, [locale.messageCenter.messages.clearFailed]);
}

async function testMessageCenterSingleDeleteFailureRestoresCompleteState() {
  const harness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    {
      deleteNotification: [{ status: 'error', message: 'failed' }],
      getMessageOverview: [createOverview(
        [{ id: 'notice-authoritative', isRead: false }],
        { total: 3, unreadCount: 2, partial: true, failedOrganizations: [{ organizationId: 'org-b' }] }
      )]
    }
  );
  seedNotifications(harness.page);

  await harness.page.deleteNotification({ currentTarget: { dataset: { id: 'notice-before' } } });

  assert.deepStrictEqual(harness.calls, ['deleteNotification', 'getMessageOverview']);
  assert.strictEqual(harness.page.data.notifications[0].id, 'notice-authoritative');
  assert.strictEqual(harness.page.data.notificationTotal, 3);
  assert.strictEqual(harness.page.data.unreadCount, 2);
  assert.strictEqual(harness.page.data.partial, true);
  assert.deepStrictEqual(harness.toasts, [locale.messageCenter.messages.deleteFailed]);
}

async function testMessageCenterPaginationAndReadCacheFailuresRemainRecoverable() {
  const paginationHarness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    { listNotifications: [{ status: 'error', message: 'failed' }] }
  );
  paginationHarness.page.data.activeTab = 'notifications';
  paginationHarness.page.data.notificationCursor = 'next-page';
  await paginationHarness.page.loadMore();
  assert.deepStrictEqual(paginationHarness.calls, ['listNotifications']);
  assert.deepStrictEqual(paginationHarness.toasts, [locale.messageCenter.messages.retryLater]);
  assert.strictEqual(paginationHarness.page.data.loadingMore, false);

  const storageHarness = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    {},
    { storageThrows: true }
  );
  await storageHarness.page.retryPendingNotificationReads();
  assert.deepStrictEqual(storageHarness.calls, [], '本地缓存不可用时不得阻断消息中心或发出错误请求');
}

async function testNotificationReadWaitsForNavigationSuccess() {
  const failedNavigation = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    {},
    { navigationSucceeds: false }
  );
  failedNavigation.page.data.notifications = [{
    id: 'notice-navigation-failed',
    organizationId: 'org-a',
    contextId: '',
    targetUrl: '/subpackages/workspace/pages/home/home',
    isRead: false
  }];
  failedNavigation.page.data.unreadCount = 1;
  await failedNavigation.page.onNotificationTap({
    currentTarget: { dataset: { id: 'notice-navigation-failed' } }
  });
  await new Promise(function(resolve) { setImmediate(resolve); });
  assert.deepStrictEqual(failedNavigation.calls, [], '目标页未打开时不得提交已读');
  assert.strictEqual(failedNavigation.page.data.notifications[0].isRead, false);
  assert.strictEqual(failedNavigation.page.data.unreadCount, 1);

  const successfulNavigation = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    { markNotificationRead: [{ status: 'success' }] },
    { navigationSucceeds: true }
  );
  successfulNavigation.page.data.notifications = [{
    id: 'notice-navigation-success',
    organizationId: 'org-a',
    contextId: '',
    targetUrl: '/subpackages/workspace/pages/home/home',
    isRead: false
  }];
  successfulNavigation.page.data.unreadCount = 1;
  await successfulNavigation.page.onNotificationTap({
    currentTarget: { dataset: { id: 'notice-navigation-success' } }
  });
  await new Promise(function(resolve) { setImmediate(resolve); });
  assert.deepStrictEqual(successfulNavigation.calls, ['markNotificationRead']);
  assert.strictEqual(successfulNavigation.page.data.notifications[0].isRead, true);
  assert.strictEqual(successfulNavigation.page.data.unreadCount, 0);

  const writeFailure = loadPage(
    'miniprogram/subpackages/message/pages/messageCenter/messageCenter.js',
    { markNotificationRead: [{ status: 'error', message: 'failed' }] },
    { navigationSucceeds: true }
  );
  writeFailure.page.data.notifications = [{
    id: 'notice-write-failed',
    organizationId: 'org-a',
    contextId: '',
    targetUrl: '/subpackages/workspace/pages/home/home',
    isRead: false
  }];
  writeFailure.page.data.unreadCount = 1;
  await writeFailure.page.onNotificationTap({
    currentTarget: { dataset: { id: 'notice-write-failed' } }
  });
  await new Promise(function(resolve) { setImmediate(resolve); });
  assert.deepStrictEqual(writeFailure.calls, ['markNotificationRead']);
  assert.strictEqual(writeFailure.page.data.notifications[0].isRead, false,
    '服务端未确认已读时界面必须保持未读');
  assert.strictEqual(writeFailure.page.data.unreadCount, 1);
}

async function testPortalMarkAllPartialAndFailureRefreshTruth() {
  const partialHarness = loadPage(
    'miniprogram/subpackages/main/pages/portal/portal.js',
    {
      markAllNotificationsRead: [{ status: 'success', partial: true }],
      getMessageOverview: [createOverview([{ id: 'portal-real', isRead: false }])]
    }
  );
  seedNotifications(partialHarness.page);
  await partialHarness.page.markAllNotificationsRead();
  assert.deepStrictEqual(partialHarness.calls, ['markAllNotificationsRead', 'getMessageOverview']);
  assert.strictEqual(partialHarness.page.data.notificationCount, 1);
  assert.strictEqual(partialHarness.page.data.notifications[0].id, 'portal-real');
  assert.deepStrictEqual(partialHarness.toasts, [locale.portal.messages.partialBulkAction]);

  const failureHarness = loadPage(
    'miniprogram/subpackages/main/pages/portal/portal.js',
    {
      markAllNotificationsRead: [new Error('network')],
      getMessageOverview: [createOverview([{ id: 'portal-after-failure', isRead: false }])]
    }
  );
  seedNotifications(failureHarness.page);
  await failureHarness.page.markAllNotificationsRead();
  assert.deepStrictEqual(failureHarness.calls, ['markAllNotificationsRead', 'getMessageOverview']);
  assert.strictEqual(failureHarness.page.data.notificationCount, 1);
  assert.strictEqual(failureHarness.page.data.notifications[0].id, 'portal-after-failure');
  assert.deepStrictEqual(failureHarness.toasts, [locale.portal.messages.incomplete]);

  const successHarness = loadPage(
    'miniprogram/subpackages/main/pages/portal/portal.js',
    { markAllNotificationsRead: [{ status: 'success', partial: false, failedOrganizations: [] }] }
  );
  seedNotifications(successHarness.page);
  await successHarness.page.markAllNotificationsRead();
  assert.deepStrictEqual(successHarness.calls, ['markAllNotificationsRead']);
  assert.strictEqual(successHarness.page.data.notificationCount, 0);
  assert.strictEqual(successHarness.page.data.notifications[0].isRead, true);
  assert.deepStrictEqual(successHarness.toasts, []);
}

function testRegistrationAndServerContract() {
  const appConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'miniprogram/app.json'), 'utf8'));
  const messagePackage = appConfig.subPackages.find((item) => item.root === 'subpackages/message');
  assert.ok(messagePackage);
  assert.ok(messagePackage.pages.includes('pages/messageCenter/messageCenter'));

  const routeSource = fs.readFileSync(
    path.join(projectRoot, 'server/src/modules/audit/routes/notification.js'),
    'utf8'
  );
  assert.match(routeSource, /partial:\s*failures\.length\s*>\s*0/);
  assert.match(routeSource, /failedOrganizations:\s*failures/);
  assert.match(routeSource, /router\.post\('\/markAllNotificationsRead'/);
  assert.match(routeSource, /router\.post\('\/deleteAllNotifications'/);
}

(async function run() {
  testRegistrationAndServerContract();
  await testMessageCenterMarkAllPartialRefreshesTruth();
  await testMessageCenterMarkAllSuccessKeepsOptimisticResult();
  await testMessageCenterMarkAllFailureRollsBackAndRefreshes();
  await testMessageCenterClearPartialRefreshesTruth();
  await testMessageCenterClearSuccessKeepsOptimisticResult();
  await testMessageCenterClearFailureRollsBackAndRefreshes();
  await testMessageCenterSingleDeleteFailureRestoresCompleteState();
  await testMessageCenterPaginationAndReadCacheFailuresRemainRecoverable();
  await testNotificationReadWaitsForNavigationSuccess();
  await testPortalMarkAllPartialAndFailureRefreshTruth();
  console.log('跨组织通知批量操作前端一致性测试通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
