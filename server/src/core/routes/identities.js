const localeCopy = require('../../locales/zh-CN/generated/core/routes/identities');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../utils/helpers');
const { nowMysqlUtc } = require('../../utils/dateTime');
const { getCurrentOrgId } = require('../../utils/orgContext');
const identityModel = require('../models/identity');
const { resolveRequestAdmin: ensureAdmin } = require('../services/adminRequestContext');
const { getAuthenticatedContext } = require('../services/authenticatedContext');
const pool = require('../../config/db');
const personnelCopy = require('../../locales/zh-CN/core/personnel');
const dictionaryUsage = require('../services/dictionaryUsage');

// listIdentities
router.post('/listIdentities', async (req, res) => {
  try {
    if (!getAuthenticatedContext(req)) return res.json({ status: 'forbidden', message: localeCopy.copy_20ca49e5e7 });

    const rows = await identityModel.getAll();
    const identities = rows.map((item) => ({
      id: safeString(item.id),
      key: safeString(item.id),
      name: safeString(item.name),
      description: safeString(item.description)
    })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    res.json({ status: 'success', identityCategories: identities, identities });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveIdentity
router.post('/saveIdentity', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    const name = safeString(req.body.name);
    const description = safeString(req.body.description);

    if (!name) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_268f818f6f });
    }

    const orgId = await getCurrentOrgId();
    const [dups] = await pool.query('SELECT id FROM identities WHERE name = ? AND org_id = ?', [name, orgId]);
    if (dups.some((r) => String(r.id) !== id)) {
      return res.json({ status: 'duplicate', message: localeCopy.copy_f325d1673b });
    }

    if (id) {
      const nowUtc = nowMysqlUtc();
      await identityModel.update(id, name, description, nowUtc);
      res.json({ status: 'success', message: localeCopy.copy_4fb370f421 });
    } else {
      const newId = generateId();
      await identityModel.create(newId, name, description);
      res.json({ status: 'success', id: newId, message: localeCopy.copy_bbea341d01 });
    }
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteIdentity
router.post('/deleteIdentity', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_10d3269bb4 });

    const orgId = await getCurrentOrgId();
    const deletion = await dictionaryUsage.deleteUnused('identity', id, orgId);
    if (deletion.status === 'in_use') {
      return res.json({ status: 'in_use', message: personnelCopy.dictionaryInUse, usages: deletion.usages });
    }
    if (deletion.status !== 'success') {
      return res.json({ status: deletion.status, message: localeCopy.copy_10d3269bb4 });
    }
    res.json({ status: 'success', message: localeCopy.copy_c2fabccf92 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

module.exports = router;
