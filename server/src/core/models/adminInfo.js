const pool = require('../../config/db');
const { getCurrentOrgId } = require('../../utils/orgContext');
async function getById(id) {
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query(
    "SELECT * FROM admin_info WHERE id = ? AND (org_id = ? OR (admin_level = 'super_admin' AND org_id = ?))",
    [id, orgId, '']
  );
  return rows[0] || null;
}

async function getByIdGlobal(id, connection, lock) {
  const db = connection || pool;
  const [rows] = await db.query(
    `SELECT * FROM admin_info WHERE id = ? AND admin_level IN ('super_admin', 'admin') LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] || null;
}

async function listVisible(operator, orgId, connection) {
  const db = connection || pool;
  if (operator.admin_level === 'super_admin') {
    const [rows] = await db.query(
      `SELECT * FROM admin_info
        WHERE (admin_level = 'super_admin' AND org_id = '')
           OR (admin_level = 'admin' AND org_id = ?)
        ORDER BY FIELD(admin_level, 'super_admin', 'admin'), name, student_id`,
      [orgId]
    );
    return rows;
  }
  const [rows] = await db.query(
    "SELECT * FROM admin_info WHERE admin_level = 'admin' AND org_id = ? ORDER BY name, student_id",
    [orgId]
  );
  return rows;
}

async function getAll(operator) {
  const orgId = await getCurrentOrgId();
  return listVisible(operator, orgId);
}

async function listByIdsInOrg(ids, orgId) {
  const adminIds = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
  if (!adminIds.length || !orgId) return [];
  const [rows] = await pool.query(
    `SELECT id, name
       FROM admin_info
      WHERE id IN (?)
        AND (org_id = ? OR (admin_level = 'super_admin' AND org_id = ''))`,
    [adminIds, orgId]
  );
  return rows;
}

async function create(id, data, connection) {
  const db = connection || pool;
  const { name, studentId, openid, adminLevel, bindStatus, inviteCode, invitedAt, inviteExpiresAt } = data;
  const orgId = adminLevel === 'super_admin' ? '' : (data.orgId || await getCurrentOrgId());
  await db.query(
    `INSERT INTO admin_info
      (id, name, student_id, openid, admin_level, bind_status, invite_code,
       invited_at, invite_expires_at, invite_consumed_at, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [id, name || '', studentId || '', openid || '', adminLevel || 'admin',
     bindStatus || 'invited', inviteCode || null, invitedAt || null, inviteExpiresAt || null, orgId]
  );
}

async function update(id, data) {
  const fields = [];
  const values = [];
  const allowedFields = ['name', 'student_id', 'openid', 'bind_status',
    'invite_code', 'invited_at', 'invite_expires_at', 'invite_consumed_at',
    'bound_at', 'updated_at'];

  for (const [key, value] of Object.entries(data)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowedFields.includes(dbKey)) {
      fields.push(`${dbKey} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;

  const orgId = await getCurrentOrgId();
  values.push(id, orgId);

  await pool.query(`UPDATE admin_info SET ${fields.join(', ')} WHERE id = ? AND (org_id = ? OR org_id = '')`, values);
}

async function remove(id) {
  const orgId = await getCurrentOrgId();
  await pool.query('DELETE FROM admin_info WHERE id = ? AND org_id = ?', [id, orgId]);
}

async function studentExists(studentId, orgId, excludeId, connection) {
  const db = connection || pool;
  const params = [studentId, orgId];
  let sql = 'SELECT id FROM admin_info WHERE student_id = ? AND org_id = ?';
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  sql += ' LIMIT 1';
  const [rows] = await db.query(sql, params);
  return rows.length > 0;
}

async function updateProfile(connection, target, data) {
  const [result] = await connection.query(
    `UPDATE admin_info SET name = ?, student_id = ?, updated_at = NOW()
      WHERE id = ? AND admin_level = ? AND org_id = ?`,
    [data.name, data.studentId, target.id, target.admin_level, target.org_id]
  );
  return result.affectedRows === 1;
}

async function updateInvite(connection, target, invite) {
  const [result] = await connection.query(
    `UPDATE admin_info
        SET invite_code = ?, invited_at = ?, invite_expires_at = ?,
            invite_consumed_at = NULL,
            openid = IF(bind_status = 'invited', NULL, openid),
            updated_at = NOW()
      WHERE id = ? AND admin_level = ? AND org_id = ?`,
    [invite.inviteCode, invite.invitedAt, invite.inviteExpiresAt,
      target.id, target.admin_level, target.org_id]
  );
  return result.affectedRows === 1;
}

async function removeExact(connection, target) {
  const [result] = await connection.query(
    'DELETE FROM admin_info WHERE id = ? AND admin_level = ? AND org_id = ?',
    [target.id, target.admin_level, target.org_id]
  );
  return result.affectedRows === 1;
}

async function lockSuperAdmins(connection) {
  const [rows] = await connection.query(
    "SELECT id, bind_status FROM admin_info WHERE admin_level = 'super_admin' AND org_id = '' FOR UPDATE"
  );
  return rows;
}

async function getByInviteCode(inviteCode) {
  const [rows] = await pool.query(
    `SELECT * FROM admin_info
      WHERE invite_code = ?
        AND bind_status = 'invited'
        AND invite_consumed_at IS NULL
        AND invite_expires_at > NOW()
      LIMIT 1`,
    [inviteCode]
  );
  return rows[0] || null;
}

async function getSuperAdmin() {
  const [rows] = await pool.query(
    "SELECT * FROM admin_info WHERE admin_level = 'super_admin' AND org_id = '' LIMIT 1"
  );
  return rows[0] || null;
}

async function getByAdminLevel(level) {
  if (level === 'super_admin') {
    const [rows] = await pool.query("SELECT * FROM admin_info WHERE admin_level = 'super_admin' AND org_id = ''");
    return rows;
  }
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query('SELECT * FROM admin_info WHERE admin_level = ? AND org_id = ?', [level, orgId]);
  return rows;
}

// 跨组织写入必须在目标事务内复核本人账号与有效管理授权，不依赖微信绑定。
async function getActiveGrantForAccountInOrganization(accountId, personId, orgId, connection, lock) {
  if (!accountId || !personId || !orgId) return null;
  const db = connection || pool;
  const [rows] = await db.query(
    `SELECT COALESCE(NULLIF(g.legacy_admin_id, ''), g.id) AS id,
            g.id AS admin_grant_id, g.person_id, g.org_id, g.admin_level,
            p.name, p.student_id
       FROM accounts a
       JOIN persons p ON p.id = a.person_id AND p.status = 'active'
       JOIN admin_grants g ON g.person_id = p.id AND g.status = 'active'
      WHERE a.id = ? AND a.person_id = ? AND a.status = 'verified'
        AND ((g.admin_level = 'super_admin' AND g.org_id = '')
          OR (g.admin_level = 'admin' AND g.org_id = ?))
      ORDER BY g.admin_level = 'super_admin' DESC, g.id
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [accountId, personId, orgId]
  );
  return rows[0] || null;
}

module.exports = {
  getActiveGrantForAccountInOrganization,
  getById, getByIdGlobal,
  listVisible, getAll, listByIdsInOrg, create, update, remove, studentExists, updateProfile, updateInvite, removeExact,
  lockSuperAdmins, getByInviteCode, getSuperAdmin, getByAdminLevel
};
