const localeCopy = require('../../../locales/zh-CN/generated/modules/audit/routes/notification');
const express = require('express');
const router = express.Router();
const { safeString } = require('../../../utils/helpers');
const { getCurrentOrgId, orgStorage } = require('../../../utils/orgContext');
const { listAccessibleActorContexts } = require('../../../core/services/accessibleOrganizations');
const notificationModel = require('../models/notification');
const todoService = require('../services/todoService');
const { getAuthenticatedContext } = require('../../../core/services/authenticatedContext');

const AGGREGATION_CONCURRENCY = 4;

function parseLimit(value) {
  return Math.max(1, Math.min(parseInt(value, 10) || 20, 50));
}

function encodeCursor(offset) {
  return offset > 0 ? Buffer.from(String(offset)).toString('base64url') : '';
}

function encodeNotificationCursor(item) {
  if (!item || !item.createdAt || !item.id) return '';
  const time = new Date(item.createdAt);
  if (Number.isNaN(time.getTime())) return '';
  return Buffer.from(JSON.stringify({
    v: 1,
    createdAt: time.toISOString(),
    id: safeString(item.id)
  })).toString('base64url');
}

function decodeNotificationCursor(value) {
  if (!value) return null;
  if (String(value).length > 512) {
    const error = new Error('invalid_notification_cursor');
    error.code = 'INVALID_NOTIFICATION_CURSOR';
    throw error;
  }
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const id = safeString(parsed && parsed.id);
    const createdAt = safeString(parsed && parsed.createdAt);
    const time = new Date(createdAt);
    if (!parsed || parsed.v !== 1 || !id || id.length > 64 || !createdAt || Number.isNaN(time.getTime())) {
      throw new Error('invalid');
    }
    return { beforeCreatedAt: time.toISOString(), beforeId: id };
  } catch (_) {
    const error = new Error('invalid_notification_cursor');
    error.code = 'INVALID_NOTIFICATION_CURSOR';
    throw error;
  }
}

function decodeCursor(value) {
  if (!value) return 0;
  try {
    const offset = parseInt(Buffer.from(String(value), 'base64url').toString('utf8'), 10);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch (_) {
    return 0;
  }
}

function getOffset(body) {
  return decodeCursor(body.cursor) || Math.max(0, parseInt(body.offset, 10) || 0);
}

function organizationMetadata(context) {
  return {
    organizationId: context.organizationId,
    organizationName: context.organizationName,
    isCurrentOrganization: context.isCurrentOrganization,
    contextId: context.contextId || '',
    identityId: context.authIdentityId || '',
    identityType: context.identityType || context.role || '',
    identityName: context.identityName || (context.role === 'admin' ? '管理员' : '普通岗位'),
    identityScope: context.identityScope || 'organization',
    isCurrentContext: Boolean(context.isCurrentContext),
    _identityPriority: context.isCurrentContext
      ? -1
      : (context.identityType === 'assignment'
        ? 0
        : (context.adminLevel === 'super_admin' ? 2 : 1))
  };
}

function withoutIdentityPriority(item) {
  const value = Object.assign({}, item);
  delete value._identityPriority;
  return value;
}

function mapNotification(row, context) {
  const targetId = safeString(row.target_id);
  const isAdminContext = safeString(context && context.role) === 'admin'
    || safeString(context && context.actor && context.actor.type) === 'admin';
  const routes = {
    submission: targetId ? '/subpackages/audit/pages/submissionDetail/submissionDetail?id=' + targetId : '',
    booking: targetId
      ? '/subpackages/venue/pages/myVenueBookings/myVenueBookings?bookingId=' + encodeURIComponent(targetId)
      : '/subpackages/venue/pages/myVenueBookings/myVenueBookings',
    score_activity: '/subpackages/workspace/pages/home/home?subApp=scoring',
    result_publication: '/subpackages/workspace/pages/home/home?subApp=scoring',
    hr_profile: isAdminContext
      ? '/subpackages/scoring/pages/admin/admin?subApp=hr&tab=hrInfo'
      : '/subpackages/workspace/pages/home/home?subApp=hr',
    account: '/subpackages/main/pages/portal/portal',
    account_security: '/subpackages/org/pages/accountSecurity/accountSecurity'
  };
  return Object.assign({
    id: safeString(row.id),
    type: safeString(row.type),
    title: safeString(row.title),
    description: safeString(row.description),
    category: safeString(row.category || 'system'),
    targetType: safeString(row.target_type),
    targetId,
    targetUrl: routes[safeString(row.target_type)] || '',
    isRead: !!row.is_read,
    createdAt: row.created_at
  }, organizationMetadata(context));
}

function compareNotifications(left, right) {
  const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
  const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftId = String(left.id || '').toLowerCase();
  const rightId = String(right.id || '').toLowerCase();
  if (leftId === rightId) return 0;
  return rightId > leftId ? 1 : -1;
}

async function settleWithConcurrency(contexts, loader) {
  const results = new Array(contexts.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < contexts.length) {
      const index = nextIndex;
      nextIndex += 1;
      const context = contexts[index];
      try {
        const value = await orgStorage.run(
          context.organizationId,
          () => loader(context)
        );
        results[index] = { ok: true, context, value };
      } catch (error) {
        results[index] = { ok: false, context, error };
      }
    }
  }

  const workerCount = Math.min(AGGREGATION_CONCURRENCY, contexts.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function collectFailures(results) {
  return results
    .filter((item) => item && !item.ok)
    .map((item) => ({
      organizationId: item.context.organizationId,
      organizationName: item.context.organizationName
    }));
}

function mergeFailures() {
  const map = new Map();
  for (const list of arguments) {
    for (const item of list || []) map.set(item.organizationId, item);
  }
  return Array.from(map.values());
}

function scopeMetadata(scope, failures) {
  const organizationMap = new Map();
  scope.allContexts.forEach((context) => {
    if (!organizationMap.has(context.organizationId)) {
      organizationMap.set(context.organizationId, {
        id: context.organizationId,
        name: context.organizationName,
        isCurrentOrganization: context.isCurrentOrganization
      });
    }
  });
  return {
    organizations: Array.from(organizationMap.values()),
    selectedOrganizationId: scope.selectedOrganizationId,
    partial: failures.length > 0,
    failedOrganizations: failures
  };
}

async function resolveScope(req, body, defaultToCurrent) {
  if (!getAuthenticatedContext(req)) {
    return { ok: false, status: 'auth_failed', message: localeCopy.copy_c22a252e97 };
  }
  const currentOrgId = await getCurrentOrgId();
  const role = 'unified';
  const allContexts = await listAccessibleActorContexts(req);
  const requestedOrganizationId = safeString(body && body.organizationId)
    || (defaultToCurrent ? currentOrgId : '');
  const contexts = requestedOrganizationId
    ? allContexts.filter((context) => context.organizationId === requestedOrganizationId)
    : allContexts;
  if (requestedOrganizationId && !contexts.length) {
    return { ok: false, status: 'org_access_denied', message: localeCopy.copy_a805235eb4 };
  }
  if (!allContexts.length) {
    return { ok: false, status: 'forbidden', message: localeCopy.copy_10d3269bb4 };
  }
  return {
    ok: true,
    role,
    currentOrgId,
    allContexts,
    contexts,
    selectedOrganizationId: requestedOrganizationId
  };
}

function respondScopeError(res, scope) {
  res.json({ status: scope.status, message: scope.message });
}

async function loadTodos(scope, body) {
  const limit = parseLimit(body.limit);
  const offset = getOffset(body);
  const results = await settleWithConcurrency(scope.contexts, async (context) => {
    const items = await orgStorage.run(
      context.organizationId,
      () => todoService.listAll(context.actor, context.organizationId)
    );
    return items.map((item) => Object.assign({}, item, organizationMetadata(context)));
  });
  const allItems = results
    .filter((item) => item.ok)
    .flatMap((item) => item.value);
  const todoMap = new Map();
  allItems.forEach((item) => {
    const key = item.organizationId + '::' + item.category + '::' + item.id;
    const existing = todoMap.get(key);
    if (!existing || item._identityPriority < existing._identityPriority) {
      todoMap.set(key, item);
    }
  });
  const uniqueItems = Array.from(todoMap.values()).sort(todoService.compareTodo);
  const items = uniqueItems.slice(offset, offset + limit).map(withoutIdentityPriority);
  const nextOffset = offset + items.length;
  return {
    data: {
      items,
      total: uniqueItems.length,
      unreadCount: 0,
      nextCursor: nextOffset < uniqueItems.length ? encodeCursor(nextOffset) : ''
    },
    failures: collectFailures(results)
  };
}

async function loadNotifications(scope, body) {
  const limit = parseLimit(body.limit);
  const boundary = decodeNotificationCursor(body.cursor);
  const fetchLimit = limit + 1;
  const results = await settleWithConcurrency(scope.contexts, async (context) => {
    const result = await notificationModel.listForRecipient(context.actor, {
      limit: fetchLimit,
      maxLimit: fetchLimit,
      beforeCreatedAt: boundary && boundary.beforeCreatedAt,
      beforeId: boundary && boundary.beforeId
    });
    return {
      items: result.items.map((row) => mapNotification(row, context)),
      total: result.total,
      unreadCount: result.unreadCount
    };
  });
  const successful = results.filter((item) => item.ok);
  const notificationMap = new Map();
  successful.forEach((result) => {
    result.value.items.forEach((item) => {
      const key = item.organizationId + '::' + item.id;
      const existing = notificationMap.get(key);
      if (!existing || item._identityPriority < existing._identityPriority) {
        notificationMap.set(key, item);
      }
    });
  });
  const allItems = Array.from(notificationMap.values()).sort(compareNotifications);
  const items = allItems.slice(0, limit).map(withoutIdentityPriority);
  const recipientCounts = new Map();
  successful.forEach((result) => {
    const actor = result.context.actor || {};
    const key = result.context.organizationId + '::' + actor.type + '::' + actor.id;
    if (!recipientCounts.has(key)) recipientCounts.set(key, result.value);
  });
  const total = Array.from(recipientCounts.values())
    .reduce((sum, value) => sum + Number(value.total || 0), 0);
  const unreadCount = Array.from(recipientCounts.values())
    .reduce((sum, value) => sum + Number(value.unreadCount || 0), 0);
  return {
    data: {
      items,
      total,
      unreadCount,
      nextCursor: allItems.length > limit && items.length
        ? encodeNotificationCursor(items[items.length - 1])
        : ''
    },
    failures: collectFailures(results)
  };
}

router.post('/getMessageOverview', async (req, res) => {
  try {
    const scope = await resolveScope(req, req.body || {}, false);
    if (!scope.ok) return respondScopeError(res, scope);
    const limit = parseLimit(req.body.limit || 10);
    const [todos, notifications] = await Promise.all([
      loadTodos(scope, { limit }),
      loadNotifications(scope, { limit })
    ]);
    const failures = mergeFailures(todos.failures, notifications.failures);
    res.json(Object.assign(
      { status: 'success', todos: todos.data, notifications: notifications.data },
      scopeMetadata(scope, failures)
    ));
  } catch (error) {
    console.error('[message:overview] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_e52119b17e });
  }
});

router.post('/listTodos', async (req, res) => {
  try {
    const scope = await resolveScope(req, req.body || {}, false);
    if (!scope.ok) return respondScopeError(res, scope);
    const result = await loadTodos(scope, req.body || {});
    res.json(Object.assign(
      { status: 'success' },
      result.data,
      scopeMetadata(scope, result.failures)
    ));
  } catch (error) {
    console.error('[todo:list] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_e52119b17e });
  }
});

router.post('/getTodoCount', async (req, res) => {
  try {
    const scope = await resolveScope(req, req.body || {}, false);
    if (!scope.ok) return respondScopeError(res, scope);
    const result = await loadTodos(scope, { limit: 1 });
    res.json(Object.assign(
      { status: 'success', count: result.data.total },
      scopeMetadata(scope, result.failures)
    ));
  } catch (error) {
    console.error('[todo:count] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_e52119b17e });
  }
});

router.post('/listNotifications', async (req, res) => {
  try {
    const scope = await resolveScope(req, req.body || {}, false);
    if (!scope.ok) return respondScopeError(res, scope);
    const result = await loadNotifications(scope, req.body || {});
    res.json(Object.assign(
      { status: 'success' },
      result.data,
      scopeMetadata(scope, result.failures)
    ));
  } catch (error) {
    if (error.code === 'INVALID_NOTIFICATION_CURSOR') {
      return res.json({
        status: 'invalid_params',
        message: localeCopy.copy_3d25d623ad
      });
    }
    console.error('[notification:list] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_e52119b17e });
  }
});

router.post('/getNotificationUnreadCount', async (req, res) => {
  try {
    const scope = await resolveScope(req, req.body || {}, false);
    if (!scope.ok) return respondScopeError(res, scope);
    const result = await loadNotifications(scope, { limit: 1 });
    res.json(Object.assign(
      { status: 'success', count: result.data.unreadCount },
      scopeMetadata(scope, result.failures)
    ));
  } catch (error) {
    console.error('[notification:count] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_e52119b17e });
  }
});

router.post('/markNotificationRead', async (req, res) => {
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_3d25d623ad });
    const scope = await resolveScope(req, req.body || {}, true);
    if (!scope.ok) return respondScopeError(res, scope);
    const attempts = await settleWithConcurrency(scope.contexts, (context) => notificationModel.markRead(id, context.actor));
    const result = attempts.filter((item) => item.ok).map((item) => item.value).find((item) => item.found)
      || { found: false };
    const failures = collectFailures(attempts);
    if (!result.found && failures.length) {
      return res.json(Object.assign(
        { status: 'error', message: localeCopy.copy_6c3f2c0f17 },
        scopeMetadata(scope, failures)
      ));
    }
    if (!result.found) return res.json({ status: 'not_found', message: localeCopy.copy_3d25d623ad });
    res.json({ status: 'success', changed: result.changed, unreadCount: result.unreadCount });
  } catch (error) {
    console.error('[notification:markRead] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_6c3f2c0f17 });
  }
});

router.post('/markAllNotificationsRead', async (req, res) => {
  try {
    const scope = await resolveScope(req, req.body || {}, false);
    if (!scope.ok) return respondScopeError(res, scope);
    const results = await settleWithConcurrency(
      scope.contexts,
      (context) => notificationModel.markAllRead(context.actor)
    );
    const failures = collectFailures(results);
    const changedCount = results
      .filter((item) => item.ok)
      .reduce((sum, item) => sum + Number(item.value.changedCount || 0), 0);
    res.json(Object.assign(
      { status: 'success', changedCount, unreadCount: 0 },
      scopeMetadata(scope, failures)
    ));
  } catch (error) {
    console.error('[notification:markAllRead] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_6c3f2c0f17 });
  }
});

router.post('/deleteAllNotifications', async (req, res) => {
  try {
    const scope = await resolveScope(req, req.body || {}, false);
    if (!scope.ok) return respondScopeError(res, scope);
    const results = await settleWithConcurrency(
      scope.contexts,
      (context) => notificationModel.deleteAll(context.actor)
    );
    const failures = collectFailures(results);
    const deletedCount = results
      .filter((item) => item.ok)
      .reduce((sum, item) => sum + Number(item.value.deletedCount || 0), 0);
    res.json(Object.assign(
      { status: 'success', deletedCount, unreadCount: 0 },
      scopeMetadata(scope, failures)
    ));
  } catch (error) {
    console.error('[notification:deleteAll] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_d696cb9250 });
  }
});

router.post('/deleteNotification', async (req, res) => {
  try {
    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_3d25d623ad });
    const scope = await resolveScope(req, req.body || {}, true);
    if (!scope.ok) return respondScopeError(res, scope);
    const attempts = await settleWithConcurrency(scope.contexts, (context) => notificationModel.deleteById(id, context.actor));
    const result = attempts.filter((item) => item.ok).map((item) => item.value).find((item) => item.found)
      || { found: false };
    const failures = collectFailures(attempts);
    if (!result.found && failures.length) {
      return res.json(Object.assign(
        { status: 'error', message: localeCopy.copy_076bb5d383 },
        scopeMetadata(scope, failures)
      ));
    }
    if (!result.found) return res.json({ status: 'not_found', message: localeCopy.copy_3d25d623ad });
    res.json({ status: 'success', unreadCount: result.unreadCount });
  } catch (error) {
    console.error('[notification:delete] failed:', error);
    res.json({ status: 'error', message: localeCopy.copy_076bb5d383 });
  }
});

module.exports = router;
