const localeCopy = require('../../locales/zh-CN/generated/core/routes/workGroups');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../utils/helpers');
const { nowMysqlUtc } = require('../../utils/dateTime');
const { getCurrentOrgId } = require('../../utils/orgContext');
const workGroupModel = require('../models/workGroup');
const departmentModel = require('../models/department');
const { resolveRequestAdmin: ensureAdmin } = require('../services/adminRequestContext');
const { getAuthenticatedContext } = require('../services/authenticatedContext');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const dictionaryUsage = require('../services/dictionaryUsage');

// listWorkGroups
router.post('/listWorkGroups', async (req, res) => {
  try {
    if (!getAuthenticatedContext(req)) return res.json({ status: 'forbidden', message: localeCopy.copy_20ca49e5e7 });

    const departments = await departmentModel.getAll();
    const departmentsById = new Map(departments.map((d) => [d.id, safeString(d.name)]));

    const rows = await workGroupModel.getAll();
    const workGroups = rows.map((item) => ({
      id: safeString(item.id),
      name: safeString(item.name),
      departmentId: safeString(item.department_id),
      departmentName: safeString(departmentsById.get(safeString(item.department_id)) || item.department_name),
      description: safeString(item.description)
    })).sort((a, b) => {
      const dept = (a.departmentName || a.departmentId).localeCompare(b.departmentName || b.departmentId, 'zh-CN');
      return dept || a.name.localeCompare(b.name, 'zh-CN');
    });

    res.json({ status: 'success', workGroups });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveWorkGroup
router.post('/saveWorkGroup', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    const name = safeString(req.body.name);
    const departmentId = safeString(req.body.departmentId);
    const description = safeString(req.body.description);

    if (!name) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_52f38ea0cf });
    }
    if (!departmentId) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_502fd5f067 });
    }

    const orgId = await getCurrentOrgId();
    const newId = id ? '' : generateId();
    const nowUtc = nowMysqlUtc();
    const saved = await dictionaryUsage.saveWorkGroupDefinition({
      id,
      name,
      departmentId,
      description,
      organizationId: orgId,
      updatedAt: nowUtc,
      newId
    });
    if (saved.status === 'invalid_department') {
      return res.json({ status: 'invalid_department', message: personnelCopy.workGroupDepartmentInvalid });
    }
    if (saved.status === 'duplicate') {
      return res.json({ status: 'duplicate', message: localeCopy.copy_a7a8b23213 });
    }
    if (saved.status === 'in_use') {
      return res.json({ status: 'in_use', message: personnelCopy.dictionaryInUse, usages: saved.usages });
    }
    if (saved.status !== 'success') {
      return res.json({ status: saved.status, message: localeCopy.copy_c4f6a0088b });
    }
    res.json(id
      ? { status: 'success', message: localeCopy.copy_4fdb08add2 }
      : { status: 'success', id: saved.id, message: localeCopy.copy_312debb693 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteWorkGroup
router.post('/deleteWorkGroup', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_c4f6a0088b });

    const orgId = await getCurrentOrgId();
    const deletion = await dictionaryUsage.deleteUnused('work_group', id, orgId);
    if (deletion.status === 'in_use') {
      return res.json({ status: 'in_use', message: personnelCopy.dictionaryInUse, usages: deletion.usages });
    }
    if (deletion.status !== 'success') {
      return res.json({ status: deletion.status, message: localeCopy.copy_c4f6a0088b });
    }
    res.json({ status: 'success', message: localeCopy.copy_1d828c61a6 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

module.exports = router;
