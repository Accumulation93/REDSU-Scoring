const pool = require('../../config/db');
const { safeString } = require('../../utils/helpers');

function uniqueIds(values) {
  return Array.from(new Set((values || []).map(safeString).filter(Boolean)));
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

// 绑定状态仅描述当前自然人的可选微信凭据，不能使用旧映射或姓名学号匹配。
async function listWechatBindingStatesByHrIds(hrIds, orgId) {
  const ids = uniqueIds(hrIds);
  if (!ids.length || !orgId) return [];
  const [rows] = await pool.query(
    `SELECT om.legacy_hr_id AS hr_id, a.id AS account_id,
            EXISTS (SELECT 1 FROM account_wechat_bindings b
                     WHERE b.account_id = a.id AND b.app_id = 'whusu-smart-workspace'
                       AND b.status = 'active') AS has_active_binding
       FROM organization_memberships om
       JOIN persons p ON p.id = om.person_id AND p.status = 'active'
       LEFT JOIN accounts a ON a.person_id = p.id
      WHERE om.org_id = ? AND om.legacy_hr_id IN (${placeholders(ids)})
        AND om.status IN ('active', 'left')`,
    [orgId, ...ids]
  );
  return rows;
}

async function resolvePersonByLegacyHrId(legacyHrId, connection, includeFormer = false) {
  const db = connection || pool;
  const [rows] = await db.query(
    `SELECT p.id, p.name, p.student_id
       FROM organization_memberships om
       JOIN persons p ON p.id = om.person_id AND p.status = 'active'
      WHERE om.legacy_hr_id = ? AND ${includeFormer ? "om.status IN ('active', 'left')" : "om.status = 'active'"}
      LIMIT 1`,
    [safeString(legacyHrId)]
  );
  return rows[0] || null;
}

async function listPersonIdentityData(legacyHrId, readableOrganizationIds, editableOrganizationIds) {
  const organizationIds = uniqueIds(readableOrganizationIds);
  if (!organizationIds.length) return null;
  const person = await resolvePersonByLegacyHrId(legacyHrId, null, true);
  if (!person) return null;
  const orgSql = placeholders(organizationIds);
  const [membershipRows, assignmentRows, grantRows] = await Promise.all([
    pool.query(
      `SELECT om.id AS membership_id, o.id AS org_id, om.legacy_hr_id, o.name AS organization_name,
              om.status AS membership_status, om.created_at AS joined_at,
              CASE WHEN om.status = 'left' THEN om.updated_at ELSE NULL END AS left_at
         FROM organizations o
         LEFT JOIN organization_memberships om
           ON om.org_id = o.id AND om.person_id = ? AND om.status IN ('active', 'left')
        WHERE o.id IN (${orgSql})
          AND (
            om.id IS NOT NULL
            OR EXISTS (
              SELECT 1
                FROM admin_grants ag
               WHERE ag.person_id = ? AND ag.org_id = o.id AND ag.status = 'active'
            )
          )
        ORDER BY o.created_at DESC, o.name ASC`,
      [person.id, ...organizationIds, person.id]
    ).then((result) => result[0]),
    pool.query(
      `SELECT ma.id, ma.membership_id, ma.org_id, ma.assignment_kind, ma.title,
              om.status AS membership_status,
              ma.department_id, ma.identity_id, ma.work_group_id,
              d.name AS department_name, i.name AS identity_name, w.name AS work_group_name
         FROM organization_memberships om
         JOIN membership_assignments ma
          ON ma.membership_id = om.id AND ma.org_id = om.org_id
          AND ((om.status = 'active' AND ma.status = 'active')
            OR (om.status = 'left' AND ma.status = 'revoked'
              AND ma.revoked_by_departure_id = om.departure_batch_id))
         LEFT JOIN departments d ON d.id = ma.department_id AND d.org_id = ma.org_id
         LEFT JOIN identities i ON i.id = ma.identity_id AND i.org_id = ma.org_id
         LEFT JOIN work_groups w ON w.id = ma.work_group_id AND w.org_id = ma.org_id
        WHERE om.person_id = ? AND om.status IN ('active', 'left') AND om.org_id IN (${orgSql})
        ORDER BY ma.created_at ASC, ma.id ASC`,
      [person.id, ...organizationIds]
    ).then((result) => result[0]),
    pool.query(
      `SELECT ag.id, ag.person_id, ag.org_id, ag.admin_level, ag.legacy_admin_id,
              ai.name, ai.student_id, ai.bind_status,
              a.status AS account_status,
              EXISTS (
                SELECT 1 FROM account_wechat_bindings b
                 WHERE b.account_id = a.id AND b.status = 'active'
              ) AS has_active_binding
         FROM admin_grants ag
         LEFT JOIN admin_info ai ON ai.id = ag.legacy_admin_id
         LEFT JOIN accounts a ON a.person_id = ag.person_id
        WHERE ag.person_id = ? AND ag.status = 'active'
          AND (ag.org_id = '' OR ag.org_id IN (${orgSql}))
        ORDER BY ag.admin_level = 'super_admin' DESC, ag.created_at ASC`,
      [person.id, ...organizationIds]
    ).then((result) => result[0])
  ]);

  const editableIds = uniqueIds(editableOrganizationIds);
  let dictionaries = { departments: [], identities: [], workGroups: [] };
  if (editableIds.length) {
    const editableSql = placeholders(editableIds);
    const [departments, identities, workGroups] = await Promise.all([
      pool.query(
        `SELECT id, org_id, name FROM departments WHERE org_id IN (${editableSql}) ORDER BY name`,
        editableIds
      ).then((result) => result[0]),
      pool.query(
        `SELECT id, org_id, name FROM identities WHERE org_id IN (${editableSql}) ORDER BY name`,
        editableIds
      ).then((result) => result[0]),
      pool.query(
        `SELECT id, org_id, department_id, name FROM work_groups
          WHERE org_id IN (${editableSql}) ORDER BY name`,
        editableIds
      ).then((result) => result[0])
    ]);
    dictionaries = { departments, identities, workGroups };
  }

  return {
    person,
    memberships: membershipRows,
    assignments: assignmentRows,
    grants: grantRows,
    dictionaries
  };
}

async function listGovernanceDirectory(organizationIds, connection = pool) {
  const orgIds = uniqueIds(organizationIds);
  if (!orgIds.length) return { memberships: [], assignments: [] };
  const orgSql = placeholders(orgIds);
  const [membershipResult, assignmentResult] = await Promise.all([
    connection.query(
      `SELECT om.legacy_hr_id AS id, om.org_id,
              COALESCE(NULLIF(p.name, ''), h.name, '') AS name,
              COALESCE(NULLIF(p.student_id, ''), h.student_id, '') AS student_id,
              om.person_id, om.id AS membership_id, om.status AS membership_status,
              om.created_at AS joined_at,
              CASE WHEN om.status = 'left' THEN om.updated_at ELSE NULL END AS left_at,
              o.name AS organization_name,
              a.id AS account_id, a.status AS account_status, a.verified_at, a.recovery_required_at,
              EXISTS (SELECT 1 FROM account_wechat_bindings b WHERE b.account_id = a.id AND b.status = 'active') AS has_active_binding,
              EXISTS (SELECT 1 FROM account_wechat_bindings history_binding WHERE history_binding.account_id = a.id) AS has_binding_history,
              EXISTS (SELECT 1 FROM account_recovery_credentials c WHERE c.account_id = a.id
                AND c.method = 'recovery_code' AND c.status = 'active') AS has_recovery_code,
              EXISTS (SELECT 1 FROM account_recovery_credentials c WHERE c.account_id = a.id
                AND c.method = 'passphrase' AND c.status = 'active') AS has_passphrase,
              (SELECT COUNT(*) FROM auth_sessions s WHERE s.account_id = a.id
                AND s.status = 'active' AND s.expires_at > NOW()) AS active_session_count,
              (SELECT claim.id FROM identity_claim_requests claim WHERE claim.person_id = om.person_id
                AND claim.requested_org_id = om.org_id AND claim.status = 'pending' AND claim.expires_at > NOW()
                ORDER BY claim.created_at DESC LIMIT 1) AS pending_claim_id,
              EXISTS (SELECT 1 FROM identity_claim_requests claim WHERE claim.person_id = om.person_id
                AND claim.requested_org_id = om.org_id AND claim.status = 'pending' AND claim.expires_at > NOW()) AS has_pending_claim,
              EXISTS (SELECT 1 FROM identity_verification_tokens token
                JOIN identity_claim_requests claim ON claim.id = token.claim_request_id
                WHERE claim.person_id = om.person_id AND claim.requested_org_id = om.org_id
                  AND claim.status = 'pending' AND claim.expires_at > NOW()
                  AND token.status = 'active' AND token.expires_at > NOW()) AS has_active_claim_code,
              EXISTS (SELECT 1 FROM identity_verification_invites invite WHERE invite.person_id = om.person_id
                AND invite.org_id = om.org_id AND invite.status = 'active' AND invite.expires_at > NOW()) AS has_active_invite,
              (SELECT recovery.id FROM account_recovery_requests recovery
                WHERE recovery.person_id = om.person_id AND recovery.status = 'pending' AND recovery.expires_at > NOW()
                ORDER BY recovery.created_at DESC LIMIT 1) AS pending_recovery_id
         FROM organization_memberships om
         JOIN persons p ON p.id = om.person_id AND p.status = 'active'
         JOIN organizations o ON o.id = om.org_id
         LEFT JOIN hr_info h ON h.id = om.legacy_hr_id AND h.org_id = om.org_id
         LEFT JOIN accounts a ON a.person_id = om.person_id
        WHERE om.org_id IN (${orgSql}) AND om.status IN ('active', 'left')
        ORDER BY om.org_id, p.name, om.legacy_hr_id`,
      orgIds
    ).then((result) => result[0]),
    connection.query(
      `SELECT assignment_row.id, assignment_row.membership_id,
              assignment_row.assignment_kind, assignment_row.department_id,
              assignment_row.identity_id, assignment_row.work_group_id,
              membership_row.status AS membership_status,
              department_row.name AS department_name,
              identity_row.name AS identity_name,
              work_group_row.name AS work_group_name
         FROM membership_assignments assignment_row
         JOIN organization_memberships membership_row
           ON membership_row.id = assignment_row.membership_id
          AND membership_row.org_id = assignment_row.org_id
         LEFT JOIN departments department_row
           ON department_row.id = assignment_row.department_id
          AND department_row.org_id = assignment_row.org_id
         LEFT JOIN identities identity_row
           ON identity_row.id = assignment_row.identity_id
          AND identity_row.org_id = assignment_row.org_id
         LEFT JOIN work_groups work_group_row
           ON work_group_row.id = assignment_row.work_group_id
          AND work_group_row.org_id = assignment_row.org_id
        WHERE assignment_row.org_id IN (${orgSql})
          AND ((membership_row.status = 'active' AND assignment_row.status = 'active')
            OR (membership_row.status = 'left' AND assignment_row.status = 'revoked'
              AND assignment_row.revoked_by_departure_id = membership_row.departure_batch_id))
        ORDER BY assignment_row.created_at, assignment_row.id`,
      orgIds
    ).then((result) => result[0])
  ]);
  return { memberships: membershipResult, assignments: assignmentResult };
}

module.exports = {
  listWechatBindingStatesByHrIds,
  resolvePersonByLegacyHrId,
  listPersonIdentityData,
  listGovernanceDirectory
};
