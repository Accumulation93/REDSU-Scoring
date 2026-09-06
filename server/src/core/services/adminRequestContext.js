const { safeString } = require('../../utils/helpers');
const { getAuthenticatedContext } = require('./authenticatedContext');

/**
 * 从认证中间件已验证的统一会话解析当前管理员。
 * 旧管理员 ID 仅作为业务记录引用，不再重新查询微信绑定或旧资料确定权限。
 */
async function resolveCurrentAdmin(req) {
  const context = getAuthenticatedContext(req);
  return adminProfileFromContext(context);
}

function adminProfileFromContext(context) {
  if (!context || context.role !== 'admin' || !safeString(context.adminGrantId)) return null;

  const adminLevel = safeString(context.adminLevel);
  const organizationId = safeString(context.organizationId);
  if (!['admin', 'super_admin'].includes(adminLevel) || !organizationId) return null;

  const legacyAdminId = safeString(context.legacyAdminId);
  return {
    id: legacyAdminId || safeString(context.adminGrantId),
    admin_grant_id: safeString(context.adminGrantId),
    admin_level: adminLevel,
    org_id: adminLevel === 'super_admin' ? '' : organizationId,
    person_id: safeString(context.personId),
    context_id: safeString(context.contextId),
    name: safeString(context.name),
    student_id: safeString(context.studentId)
  };
}

async function resolveRequestAdmin(req) {
  // 中间件的否定结论同样有权威性，不能靠重新查询绕开。
  if (req && Object.prototype.hasOwnProperty.call(req, 'admin')) return req.admin || null;
  return resolveCurrentAdmin(req);
}

module.exports = { resolveCurrentAdmin, resolveRequestAdmin, adminProfileFromContext };
