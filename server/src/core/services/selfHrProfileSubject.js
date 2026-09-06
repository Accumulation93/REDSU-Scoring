const { safeString } = require('../../utils/helpers');
const { getCurrentOrgId } = require('../../utils/orgContext');
const hrInfoModel = require('../models/hrInfo');
const personnelCopy = require('../../locales/zh-CN/core/personnel');

// 本人资料只认认证中间件确认的自然人；临时口令会话不要求微信永久绑定。
async function resolveSelfHrProfileSubject(req) {
  const account = req.authAccount;
  const context = req.authContext;
  const personId = safeString(account && account.personId);
  const organizationId = safeString(context && context.organizationId);
  const unavailable = {
    status: 'hr_profile_context_unavailable',
    message: personnelCopy.selfHrProfileContextUnavailable
  };
  if (!personId || !organizationId || !context ||
      !['user', 'admin'].includes(context.role) ||
      safeString(context.personId) !== personId ||
      safeString(await getCurrentOrgId()) !== organizationId) return unavailable;

  const hr = await hrInfoModel.getActiveByPersonIdInOrg(personId, organizationId);
  if (!hr) return {
    status: 'hr_profile_unavailable',
    message: personnelCopy.selfHrProfileUnavailable
  };
  if (safeString(hr.person_id) !== personId || safeString(hr.org_id) !== organizationId ||
      (context.role === 'user' && (
        safeString(context.legacyHrId) !== safeString(hr.id) ||
        safeString(context.membershipId) !== safeString(hr.membership_id)
      ))) return unavailable;
  return { status: 'success', hr, personId, organizationId };
}

module.exports = { resolveSelfHrProfileSubject };
