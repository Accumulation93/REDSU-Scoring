const pool = require('../../../config/db');
const { safeString } = require('../../../utils/helpers');
const { getAuthenticatedContext } = require('../../../core/services/authenticatedContext');

/**
 * 场地借用跨组织可见性所需的查看者作用域。
 *
 * - isSuperAdmin：本人有效超级管理员授权即为全局可见；
 * - globalOrgAccess：仅有效的全局超级管理员授权覆盖全部组织；
 * - orgs：本人有效组织成员关系与管理授权覆盖的组织集合；
 * - hrIds：本人组织成员的兼容 hr id 集合（仅用于识别旧借用记录）；
 * - adminIds：本人管理员 id 集合（跨组织）。
 */
async function resolveVenueViewerScope(req) {
  const context = getAuthenticatedContext(req);
  const personId = context ? safeString(context.personId) : '';
  const orgs = new Set();
  const hrIds = new Set();
  const adminIds = new Set();
  let isSuperAdmin = false;
  let globalOrgAccess = false;

  if (!personId) {
    return { isSuperAdmin, globalOrgAccess, personId: safeString(personId), orgs, hrIds, adminIds };
  }

  {
    const [membershipRows] = await pool.query(
      `SELECT DISTINCT om.org_id, om.legacy_hr_id
         FROM organization_memberships om
         JOIN persons p ON p.id = om.person_id AND p.status = 'active'
        WHERE om.person_id = ? AND om.status = 'active'`,
      [safeString(personId)]
    );
    for (const row of membershipRows) {
      const org = safeString(row.org_id);
      if (org) orgs.add(org);
      const hrId = safeString(row.legacy_hr_id);
      if (hrId) hrIds.add(hrId);
    }
  }

  // 只按认证账号的自然人查询授权；当前微信即使属于另一管理员也没有作用。
  const [grantRows] = await pool.query(
    `SELECT g.id, g.legacy_admin_id, g.org_id, g.admin_level
       FROM admin_grants g
       JOIN persons p ON p.id = g.person_id AND p.status = 'active'
      WHERE g.person_id = ? AND g.status = 'active'`,
    [personId]
  );
  for (const row of grantRows) {
    const org = safeString(row.org_id);
    const level = safeString(row.admin_level);
    const globalGrant = level === 'super_admin' && !org;
    if (!globalGrant && !(level === 'admin' && org)) continue;
    const id = safeString(row.id);
    const legacyId = safeString(row.legacy_admin_id);
    if (id) adminIds.add(id);
    if (legacyId) adminIds.add(legacyId);
    if (org) orgs.add(org);
    if (globalGrant) {
      globalOrgAccess = true;
      isSuperAdmin = true;
    }
  }

  return { isSuperAdmin, globalOrgAccess, personId: safeString(personId), orgs, hrIds, adminIds };
}

/**
 * 借用记录详情可见性：
 * 超级管理员全局可见；或 creator/approval 组织任一命中查看者组织集合；
 * 或本人创建（普通岗位 hr_id / 管理员 id）的记录。
 */
function canViewBookingDetails(booking, scope) {
  if (scope.isSuperAdmin) return true;
  const creatorOrg = safeString(booking.creator_org_id);
  const approvalOrg = safeString(booking.approval_org_id);
  if (scope.globalOrgAccess && (creatorOrg || approvalOrg)) return true;
  if (scope.orgs.has(creatorOrg) || scope.orgs.has(approvalOrg)) return true;
  const creatorPersonId = safeString(booking.creator_person_id);
  if (creatorPersonId && creatorPersonId === safeString(scope.personId)) return true;
  const userHrId = safeString(booking.user_hr_id);
  if (userHrId && scope.hrIds.has(userHrId)) return true;
  const creatorAdminId = safeString(booking.creator_admin_id);
  if (creatorAdminId && scope.adminIds.has(creatorAdminId)) return true;
  return false;
}

/**
 * 批量解析组织名称，供借用记录详情展示；organizations 为全局组织表。
 */
async function resolveVenueOrgNames(orgIds) {
  const ids = [...new Set((orgIds || []).map(id => safeString(id)).filter(Boolean))];
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT id, name FROM organizations WHERE id IN (${placeholders})`,
    ids
  );
  const map = {};
  (rows || []).forEach(r => { map[r.id] = r.name || ''; });
  return map;
}

module.exports = { resolveVenueViewerScope, canViewBookingDetails, resolveVenueOrgNames };
