const { format: localeFormat } = require('../../locales/runtime');
const localeCopy = require('../../locales/zh-CN/generated/core/routes/org');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../utils/helpers');
const { nowMysqlUtc } = require('../../utils/dateTime');
const { getCurrentOrgId } = require('../../utils/orgContext');
const organizationModel = require('../models/organization');
const systemConfigModel = require('../models/systemConfig');
const pool = require('../../config/db');
const { resolveRequestAdmin } = require('../services/adminRequestContext');

const ORG_REFERENCE_COLUMNS = new Set([
  'org_id',
  'creator_org_id',
  'approval_org_id'
]);

async function findOrganizationDependencies(conn, organizationId) {
  const [columns] = await conn.query(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND COLUMN_NAME IN ('org_id', 'creator_org_id', 'approval_org_id')
      ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  const tables = new Set();
  for (const column of columns) {
    const tableName = safeString(column.table_name);
    const columnName = safeString(column.column_name);
    if (!tableName || !ORG_REFERENCE_COLUMNS.has(columnName)) continue;
    const [rows] = await conn.query(
      'SELECT 1 AS present FROM ?? WHERE ?? = ? LIMIT 1',
      [tableName, columnName, organizationId]
    );
    if (rows.length) tables.add(tableName);
  }
  return Array.from(tables).sort();
}

// listOrganizations — admin only
router.post('/listOrganizations', async (req, res) => {
  try {
    const admin = await resolveRequestAdmin(req);
    if (!admin) {
      return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    }

    const rows = await organizationModel.getAll();
    res.json({ status: 'success', list: rows });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveOrganization
router.post('/saveOrganization', async (req, res) => {
  try {
    const id = safeString(req.body.id);
    const name = safeString(req.body.name);

    // 仅全局超级管理员可操作
    const operator = await resolveRequestAdmin(req);
    if (!operator || operator.admin_level !== 'super_admin' || operator.org_id !== '') {
      return res.json({ status: 'forbidden', message: localeCopy.copy_6809d8bae7 });
    }

    if (!name) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_a032183564 });
    }

    const [dups] = await pool.query('SELECT id FROM organizations WHERE name = ?', [name]);
    if (dups.some((r) => String(r.id) !== id)) {
      return res.json({ status: 'duplicate', message: localeCopy.copy_674b57afda });
    }

    if (id) {
      await organizationModel.update(id, name);
      res.json({ status: 'success', organization: { id, name }, message: localeCopy.copy_b32b720d56 });
    } else {
      const newId = generateId();
      await organizationModel.create(newId, name);
      res.json({ status: 'success', organization: { id: newId, name }, message: localeCopy.copy_1974dee798 });
    }
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteOrganization — only empty organizations may be deleted. Business data is
// never cascaded implicitly because independently owned modules must not be
// partially removed.
router.post('/deleteOrganization', async (req, res) => {
  try {
    const id = safeString(req.body.organizationId || req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_cc9e4b8129 });

    // 仅全局超级管理员可操作
    const operator = await resolveRequestAdmin(req);
    if (!operator || operator.admin_level !== 'super_admin' || operator.org_id !== '') {
      return res.json({ status: 'forbidden', message: localeCopy.copy_6809d8bae7 });
    }

    // 禁止删除空组织标识
    if (id === '') {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_cc9e4b8129 });
    }

    const { withTransaction } = require('../../config/db');
    const result = await withTransaction(async (conn) => {
      const [configs] = await conn.query(
        "SELECT current_organization FROM system_config WHERE id = 'default' FOR UPDATE"
      );
      if (configs[0] && safeString(configs[0].current_organization) === id) {
        return { status: 'current' };
      }

      const [organizations] = await conn.query(
        'SELECT id FROM organizations WHERE id = ? FOR UPDATE',
        [id]
      );
      if (!organizations.length) return { status: 'not_found' };

      const dependencies = await findOrganizationDependencies(conn, id);
      if (dependencies.length) {
        return { status: 'not_empty', dependencies };
      }

      const [deleteResult] = await conn.query(
        'DELETE FROM organizations WHERE id = ?',
        [id]
      );
      return { status: deleteResult.affectedRows === 1 ? 'deleted' : 'not_found' };
    });

    if (result.status === 'not_found') {
      return res.json({ status: 'not_found', message: localeCopy.copy_2c1bc34f7e });
    }
    if (result.status === 'current') {
      return res.json({ status: 'forbidden', message: localeCopy.copy_9bb30f5ebb });
    }
    if (result.status === 'not_empty') {
      return res.json({
        status: 'organization_not_empty',
        message: localeCopy.copy_a05b82962e,
        dependencyCount: result.dependencies.length
      });
    }
    res.json({ status: 'success', message: localeCopy.copy_770ca6e54d });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// getCurrentOrganization
router.post('/getCurrentOrganization', async (req, res) => {
  try {
    const config = await systemConfigModel.get();
    const orgId = config && config.current_organization;
    if (!orgId) {
      return res.json({ status: 'success', organization: null });
    }
    const org = await organizationModel.getById(orgId);
    res.json({
      status: 'success',
      organization: org ? { id: org.id, name: org.name } : null
    });
  } catch (e) {
    res.json({ status: 'success', organization: null });
  }
});

// switchOrganization — simply update system_config, no data migration
router.post('/switchOrganization', async (req, res) => {
  try {
    const targetOrgId = safeString(req.body.organizationId);
    const targetOrgName = safeString(req.body.organizationName);

    if (!targetOrgId || !targetOrgName) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_58a0afcb2d });
    }

    // Safety: prevent switching to empty org
    if (targetOrgId === '') {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_cc9e4b8129 });
    }

    // 仅全局超级管理员可切换系统默认组织
    const operator = await resolveRequestAdmin(req);
    if (!operator || operator.admin_level !== 'super_admin' || operator.org_id !== '') {
      return res.json({ status: 'forbidden', message: localeCopy.copy_6809d8bae7 });
    }

    const nowUtc = nowMysqlUtc();
    await systemConfigModel.ensureExists();
    const { withTransaction } = require('../../config/db');
    const switchResult = await withTransaction(async (conn) => {
      const [configs] = await conn.query(
        "SELECT current_organization FROM system_config WHERE id = 'default' FOR UPDATE"
      );
      const currentOrgId = configs[0] && safeString(configs[0].current_organization);
      if (currentOrgId === targetOrgId) return { unchanged: true };

      const [existingOrg] = await conn.query(
        'SELECT id FROM organizations WHERE id = ? FOR UPDATE',
        [targetOrgId]
      );
      if (existingOrg.length) {
        await conn.query(
          'UPDATE organizations SET name = ? WHERE id = ?',
          [targetOrgName, targetOrgId]
        );
      } else {
        await conn.query(
          'INSERT INTO organizations (id, name) VALUES (?, ?)',
          [targetOrgId, targetOrgName]
        );
      }
      await conn.query(
        "UPDATE system_config SET current_organization = ?, updated_at = ? WHERE id = 'default'",
        [targetOrgId, nowUtc]
      );
      return { unchanged: false };
    });

    res.json({
      status: 'success',
      message: switchResult.unchanged
        ? localeCopy.copy_7fa30fc815
        : localeFormat(localeCopy.copy_ab11e098b6, [targetOrgName])
    });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) || localeCopy.copy_53d5e0a0c8 });
  }
});

module.exports = router;
