const localeCopy = require('../../locales/zh-CN/generated/core/routes/departments');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../utils/helpers');
const { nowMysqlUtc } = require('../../utils/dateTime');
const { getCurrentOrgId } = require('../../utils/orgContext');
const departmentModel = require('../models/department');
const { resolveRequestAdmin: ensureAdmin } = require('../services/adminRequestContext');
const { getAuthenticatedContext } = require('../services/authenticatedContext');
const pool = require('../../config/db');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const dictionaryUsage = require('../services/dictionaryUsage');

// listDepartments
router.post('/listDepartments', async (req, res) => {
  try {
    if (!getAuthenticatedContext(req)) return res.json({ status: 'forbidden', message: localeCopy.copy_20ca49e5e7 });

    const rows = await departmentModel.getAll();
    const departments = rows.map((item) => ({
      id: safeString(item.id),
      key: safeString(item.id),
      name: safeString(item.name),
      description: safeString(item.description)
    })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    res.json({ status: 'success', departments });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveDepartment
router.post('/saveDepartment', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    const name = safeString(req.body.name);
    const description = safeString(req.body.description);

    if (!name) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_d8e285efa5 });
    }

    const orgId = await getCurrentOrgId();
    const [dups] = await pool.query('SELECT id FROM departments WHERE name = ? AND org_id = ?', [name, orgId]);
    if (dups.some((r) => String(r.id) !== id)) {
      return res.json({ status: 'duplicate', message: localeCopy.copy_6bd58acd2e });
    }

    if (id) {
      const nowUtc = nowMysqlUtc();
      await departmentModel.update(id, name, description, nowUtc);
      res.json({ status: 'success', message: localeCopy.copy_47ce504d84 });
    } else {
      const newId = generateId();
      await departmentModel.create(newId, name, description);
      res.json({ status: 'success', id: newId, message: localeCopy.copy_3e47a3372b });
    }
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteDepartment
router.post('/deleteDepartment', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_9f09d6a2b3 });

    const orgId = await getCurrentOrgId();
    const deletion = await dictionaryUsage.deleteUnused('department', id, orgId);
    if (deletion.status === 'in_use') {
      return res.json({ status: 'in_use', message: personnelCopy.dictionaryInUse, usages: deletion.usages });
    }
    if (deletion.status !== 'success') {
      return res.json({ status: deletion.status, message: localeCopy.copy_9f09d6a2b3 });
    }
    res.json({ status: 'success', message: localeCopy.copy_e7dcd6f241 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

module.exports = router;
