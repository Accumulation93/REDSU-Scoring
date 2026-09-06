const { safeString } = require('../../utils/helpers');
const identityModel = require('../models/unifiedIdentity');
const { getAuthenticatedContext } = require('./authenticatedContext');
const { adminProfileFromContext } = require('./adminRequestContext');

const ACTIVE_ROLES = new Set(['user', 'admin']);

function actorFromContext(context) {
  const common = {
    type: context.role,
    personId: safeString(context.personId),
    contextId: safeString(context.contextId),
    name: safeString(context.name)
  };
  if (context.role === 'admin') {
    const profile = adminProfileFromContext(context);
    if (!profile) return null;
    return Object.assign(common, {
      id: profile.id,
      adminGrantId: safeString(context.adminGrantId),
      adminLevel: safeString(context.adminLevel),
      profile
    });
  }
  const hrId = safeString(context.legacyHrId);
  if (context.role !== 'user' || !hrId) return null;
  return Object.assign(common, {
    id: hrId,
    membershipId: safeString(context.membershipId),
    assignmentId: safeString(context.assignmentId),
    profile: {
      id: hrId,
      person_id: common.personId,
      org_id: safeString(context.organizationId),
      name: common.name,
      department_id: safeString(context.departmentId),
      identity_id: safeString(context.identityCategoryId || context.identityId),
      work_group_id: safeString(context.workGroupId)
    }
  });
}

/**
 * 跨组织目录只来自当前已认证账号的有效工作角色，不按微信或姓名匹配人员。
 * role 留空用于消息聚合全部角色；指定角色只缩小范围，不改变当前会话。
 */
async function listAccessibleActorContexts(req, role) {
  const selected = getAuthenticatedContext(req);
  if (!selected || (role && !ACTIVE_ROLES.has(role))) return [];
  const contexts = await identityModel.listContexts(req.authAccount.id);
  return contexts.filter(context => (
    context.personId === selected.personId && (!role || context.role === role)
  )).map(context => Object.assign({}, context, {
    isCurrentOrganization: context.organizationId === selected.organizationId,
    isCurrentContext: context.contextId === selected.contextId,
    actor: actorFromContext(context)
  })).filter(context => context.actor && context.actor.id);
}

async function listAvailableOrganizations(req, role) {
  const contexts = await listAccessibleActorContexts(req, role);
  const seen = new Set();
  return contexts.filter(context => {
    if (seen.has(context.organizationId)) return false;
    seen.add(context.organizationId);
    return true;
  }).map(context => ({ id: context.organizationId, name: context.organizationName, role }));
}

module.exports = { ACTIVE_ROLES, actorFromContext, listAccessibleActorContexts, listAvailableOrganizations };
