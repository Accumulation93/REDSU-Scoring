const localeCopy = require('../../locales/zh-CN/generated/core/services/currentActor');
const { safeString } = require('../../utils/helpers');
const hrInfoModel = require('../models/hrInfo');
const { resolveCurrentAdmin } = require('./adminRequestContext');
const { getAuthenticatedContext } = require('./authenticatedContext');

const ACTIVE_ROLES = new Set(['user', 'admin']);

/**
 * 按认证中间件验证过的当前工作角色解析业务主体。
 * 请求头只保留兼容用途，不参与主体或权限判断。
 */
async function resolveCurrentActor(req) {
  const context = getAuthenticatedContext(req);
  if (context) {
    if (context.role === 'admin') {
      const admin = await resolveCurrentAdmin(req);
      if (!admin) {
        return { ok: false, status: 'forbidden', message: localeCopy.copy_8dd829b03b };
      }
      return {
        ok: true,
        actor: {
          type: 'admin',
          id: safeString(admin.id),
          personId: safeString(context.personId),
          contextId: safeString(context.contextId),
          adminGrantId: safeString(context.adminGrantId),
          adminLevel: safeString(context.adminLevel),
          name: safeString(context.name),
          profile: admin
        }
      };
    }
    const hrId = safeString(context.legacyHrId);
    if (!hrId) return { ok: false, status: 'forbidden', message: localeCopy.copy_0fbde52b4b };
    const hr = await hrInfoModel.getById(hrId);
    if (!hr) return { ok: false, status: 'forbidden', message: localeCopy.copy_12799b0f7a };
    const profile = Object.assign({}, hr, {
      department_id: safeString(context.departmentId),
      identity_id: safeString(context.identityId),
      work_group_id: safeString(context.workGroupId)
    });
    return {
      ok: true,
      actor: {
        type: 'user',
        id: hrId,
        personId: safeString(context.personId),
        membershipId: safeString(context.membershipId),
        assignmentId: safeString(context.assignmentId),
        contextId: safeString(context.contextId),
        name: safeString(context.name),
        profile
      }
    };
  }

  return {
    ok: false,
    status: 'work_context_required',
    message: localeCopy.copy_10d3269bb4
  };
}

module.exports = { resolveCurrentActor, ACTIVE_ROLES };
