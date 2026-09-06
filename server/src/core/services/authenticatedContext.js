const { safeString } = require('../../utils/helpers');

/**
 * 业务入口只接受认证中间件注入的账号与工作角色。
 * 微信标识、请求体和兼容请求头都不能补充或替换主体。
 */
function getAuthenticatedContext(req) {
  const account = req && req.authAccount;
  const context = req && req.authContext;
  if (!account || !context || !safeString(account.id) || !safeString(account.personId)) return null;
  if (safeString(account.personId) !== safeString(context.personId)) return null;
  if (!['user', 'admin'].includes(context.role)) return null;
  if (!safeString(context.contextId) || !safeString(context.organizationId)) return null;
  return context;
}

module.exports = { getAuthenticatedContext };
