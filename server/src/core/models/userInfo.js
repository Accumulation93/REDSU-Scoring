const pool = require('../../config/db');
const { getCurrentOrgId } = require('../../utils/orgContext');

async function getById(id) {
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query('SELECT * FROM user_info WHERE id = ? AND org_id = ?', [id, orgId]);
  return rows[0] || null;
}

async function getAll() {
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query('SELECT * FROM user_info WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
  return rows;
}

async function create(id, openid, hrId) {
  const orgId = await getCurrentOrgId();
  await pool.query(
    'INSERT INTO user_info (id, openid, hr_id, org_id) VALUES (?, ?, ?, ?)',
    [id, openid, hrId || '', orgId]
  );
}

async function update(id, hrId, updatedAt) {
  const orgId = await getCurrentOrgId();
  await pool.query('UPDATE user_info SET hr_id = ?, updated_at = ? WHERE id = ? AND org_id = ?', [hrId || '', updatedAt || null, id, orgId]);
}

async function getByHrId(hrId, excludeOpenid) {
  const orgId = await getCurrentOrgId();
  const [rows] = await pool.query(
    'SELECT * FROM user_info WHERE hr_id = ? AND openid != ? AND org_id = ? LIMIT 1',
    [hrId, excludeOpenid, orgId]
  );
  return rows[0] || null;
}

async function remove(id) {
  const orgId = await getCurrentOrgId();
  await pool.query('DELETE FROM user_info WHERE id = ? AND org_id = ?', [id, orgId]);
}

async function getByHrIdInOrg(hrId, excludeOpenid, orgId) {
  const [rows] = await pool.query(
    'SELECT * FROM user_info WHERE hr_id = ? AND openid != ? AND org_id = ? LIMIT 1',
    [hrId, excludeOpenid, orgId]
  );
  return rows[0] || null;
}

async function listByHrIdsInOrg(hrIds, orgId) {
  const ids = Array.isArray(hrIds) ? hrIds.filter(Boolean) : [];
  if (!ids.length || !orgId) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT id, hr_id, openid
       FROM user_info
      WHERE org_id = ? AND hr_id IN (${placeholders})`,
    [orgId, ...ids]
  );
  return rows;
}

async function listBoundIdentitiesOutsideOrg(studentIds, orgId) {
  const ids = Array.isArray(studentIds) ? studentIds.filter(Boolean) : [];
  if (!ids.length || !orgId) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT DISTINCT h.student_id, h.name
       FROM user_info ui
       INNER JOIN hr_info h ON h.id = ui.hr_id AND h.org_id = ui.org_id
      WHERE ui.org_id <> ? AND h.student_id IN (${placeholders})`,
    [orgId, ...ids]
  );
  return rows;
}

async function lockByHrIdInOrg(hrId, orgId, connection) {
  const db = connection || pool;
  const [rows] = await db.query(
    `SELECT id, openid, hr_id, org_id
       FROM user_info
      WHERE hr_id = ? AND org_id = ?
      FOR UPDATE`,
    [hrId, orgId]
  );
  return rows;
}

async function lockByOpenidsGlobal(openids, connection) {
  const ids = Array.isArray(openids) ? [...new Set(openids.filter(Boolean))] : [];
  if (!ids.length) return [];
  const db = connection || pool;
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT id, openid, hr_id, org_id
       FROM user_info
      WHERE openid IN (${placeholders})
      FOR UPDATE`,
    ids
  );
  return rows;
}

async function removeByOpenidsGlobal(openids, connection) {
  const ids = Array.isArray(openids) ? [...new Set(openids.filter(Boolean))] : [];
  if (!ids.length) return 0;
  const db = connection || pool;
  const placeholders = ids.map(() => '?').join(',');
  const [result] = await db.query(
    `DELETE FROM user_info WHERE openid IN (${placeholders})`,
    ids
  );
  return Number(result.affectedRows || 0);
}

// 创建绑定到指定组织
async function createInOrg(id, openid, hrId, orgId) {
  await pool.query(
    'INSERT INTO user_info (id, openid, hr_id, org_id) VALUES (?, ?, ?, ?)',
    [id, openid, hrId || '', orgId]
  );
}

async function updateInOrg(id, hrId, updatedAt, orgId) {
  await pool.query(
    'UPDATE user_info SET hr_id = ?, updated_at = ? WHERE id = ? AND org_id = ?',
    [hrId || '', updatedAt || null, id, orgId]
  );
}

module.exports = {
  getById, getByHrId, getByHrIdInOrg, getAll,
  listByHrIdsInOrg, listBoundIdentitiesOutsideOrg,
  lockByHrIdInOrg, lockByOpenidsGlobal, removeByOpenidsGlobal,
  create, createInOrg, update, updateInOrg, remove
};
