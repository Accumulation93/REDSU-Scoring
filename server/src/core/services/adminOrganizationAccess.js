const localeCopy = require('../../locales/zh-CN/generated/core/services/adminOrganizationAccess');
const { safeString } = require('../../utils/helpers');
const adminInfoModel = require('../models/adminInfo');
const { listAccessibleActorContexts } = require('./accessibleOrganizations');
const { loadEffectivePermissions, hasAnyPermission } = require('./adminPermissions');
const { getAuthenticatedContext } = require('./authenticatedContext');

class AdminOrganizationAccessError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'AdminOrganizationAccessError';
    this.code = code;
    this.httpStatus = httpStatus || 403;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function listAdminOrganizationAccess(req) {
  const selected = getAuthenticatedContext(req);
  if (!selected || selected.role !== 'admin') return [];
  const available = await listAccessibleActorContexts(req, 'admin');
  const organizationContexts = new Map();
  available.forEach(context => {
    const previous = organizationContexts.get(context.organizationId);
    if (!previous || context.actor.adminLevel === 'super_admin') {
      organizationContexts.set(context.organizationId, context);
    }
  });
  const contexts = Array.from(organizationContexts.values());
  return mapWithConcurrency(contexts, 4, async (context) => {
    const admin = context.actor && context.actor.profile;
    const effective = await loadEffectivePermissions(admin, context.organizationId);
    const permissions = effective.permissions || {};
    const permissionKeys = Object.keys(permissions).filter((key) => permissions[key]);
    return {
      organizationId: context.organizationId,
      organizationName: context.organizationName,
      admin,
      isSuperAdmin: Boolean(effective.isSuper),
      permissionKeys,
      canReadPeople: Boolean(
        permissions['hr.people'] || permissions['hr.profile_review']
        || permissions['auth.identity.verify'] || permissions['auth.accounts.recover']
        || permissions['auth.accounts.global_manage'] || permissions['auth.policy.manage']
      ),
      canReadAssignments: Boolean(permissions['hr.people'] || permissions['hr.profile_review']),
      canEditAssignments: Boolean(permissions['hr.people']),
      canReadAdmins: Boolean(
        permissions['system.admin_accounts.read']
        || permissions['system.admin_accounts.write']
      ),
      canEditAdmins: Boolean(permissions['system.admin_accounts.write'])
    };
  });
}

async function requireAdminOrganizationPermission(req, organizationId, permissionKeys, connection) {
  const orgId = safeString(organizationId);
  if (!orgId) {
    throw new AdminOrganizationAccessError('invalid_organization', localeCopy.copy_cc9e4b8129, 400);
  }
  const selected = getAuthenticatedContext(req);
  if (!selected || selected.role !== 'admin') {
    throw new AdminOrganizationAccessError('organization_forbidden', localeCopy.copy_33bbc50b8f, 403);
  }
  const admin = await adminInfoModel.getActiveGrantForAccountInOrganization(
    safeString(req.authAccount.id),
    safeString(selected.personId),
    orgId,
    connection,
    Boolean(connection)
  );
  if (!admin) {
    throw new AdminOrganizationAccessError('organization_forbidden', localeCopy.copy_33bbc50b8f, 403);
  }
  const effective = await loadEffectivePermissions(admin, orgId, connection);
  if (!hasAnyPermission(effective, permissionKeys)) {
    throw new AdminOrganizationAccessError('permission_denied', localeCopy.copy_5914228d50, 403);
  }
  return { admin, effective, organizationId: orgId };
}

module.exports = {
  AdminOrganizationAccessError,
  listAdminOrganizationAccess,
  requireAdminOrganizationPermission
};
