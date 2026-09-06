const localeCopy = require('../../../locales/zh-CN/generated/modules/scoring/routes/activities');
const scoringCopy = require('../../../locales/zh-CN/modules/scoring');
const express = require('express');
const router = express.Router();
const { safeString, generateId } = require('../../../utils/helpers');
const { nowMysqlUtc, formatDateOnly } = require('../../../utils/dateTime');
const { resolveRequestAdmin: ensureAdmin } = require('../../../core/services/adminRequestContext');
const activityModel = require('../models/scoreActivity');
const pool = require('../../../config/db');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const pubCache = require('../utils/pubCache');
const sharedCache = require('../utils/sharedCache');

// listScoreActivities
router.post('/listScoreActivities', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    function fmtDate(v) {
      if (!v) return '';
      const s = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      if (v instanceof Date && !isNaN(v)) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
      }
      return s.slice(0, 10);
    }
    const data = await activityModel.getAll();
    const list = data.map((item) => ({
      id: item.id,
      name: item.name || '',
      description: item.description || '',
      startDate: fmtDate(item.start_date),
      endDate: fmtDate(item.end_date),
      isCurrent: !!item.is_current,
      participantGranularity: 'assignment',
      isPaused: !!item.is_paused,
      updatedAt: item.updated_at || null
    })).sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });

    res.json({
      status: 'success',
      list,
      currentActivityId: (list.find((item) => item.isCurrent) || {}).id || ''
    });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// saveScoreActivity
router.post('/saveScoreActivity', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    const name = safeString(req.body.name);
    const description = safeString(req.body.description);
    const startDate = safeString(req.body.startDate);
    const endDate = safeString(req.body.endDate);
    const hasPausedValue = Object.prototype.hasOwnProperty.call(req.body, 'isPaused');
    const requestedPaused = req.body.isPaused === true || req.body.isPaused === 1 ? 1 : 0;
    const participantGranularity = 'assignment';

    if (!name) return res.json({ status: 'invalid_params', message: localeCopy.copy_e394895492 });
    if ((startDate && !formatDateOnly(startDate)) || (endDate && !formatDateOnly(endDate))) {
      return res.json({ status: 'invalid_params', message: scoringCopy.activityDateInvalid });
    }
    if (startDate && endDate && startDate > endDate) {
      return res.json({ status: 'invalid_params', message: localeCopy.copy_0b091cba77 });
    }

    if (id) {
      const nowUtc = nowMysqlUtc();
      const current = await activityModel.getById(id);
      if (!current) return res.json({ status: 'not_found', message: localeCopy.copy_4f0d449737 });
      const orgId = await getCurrentOrgId();
      const [duplicates] = await pool.query(
        'SELECT id FROM score_activities WHERE name = ? AND org_id = ? AND id <> ? LIMIT 1',
        [name, orgId, id]
      );
      if (duplicates.length) {
        return res.json({ status: 'duplicate', message: localeCopy.copy_8aeb0338bf });
      }
      if (current && current.participant_granularity !== participantGranularity) {
        const [recordRows] = await pool.query(
          'SELECT 1 FROM score_records WHERE activity_id = ? AND org_id = ? LIMIT 1',
          [id, orgId]
        );
        if (recordRows.length) {
          return res.json({ status: 'conflict', message: localeCopy.copy_48f70c55c9 });
        }
      }
      await activityModel.update(id, {
        name, description, startDate: startDate || null, endDate: endDate || null,
        isCurrent: current ? !!current.is_current : false,
        isPaused: hasPausedValue ? requestedPaused : Boolean(current.is_paused),
        participantGranularity,
        updatedBy: admin.id, updatedAt: nowUtc
      });
    } else {
      const orgId = await getCurrentOrgId();
      const [existing] = await pool.query('SELECT * FROM score_activities WHERE name = ? AND org_id = ? LIMIT 1', [name, orgId]);
      if (existing.length) {
        return res.json({ status: 'duplicate', message: localeCopy.copy_8aeb0338bf });
      } else {
        const newId = generateId();
        await activityModel.create(newId, {
          name, description, startDate: startDate || null, endDate: endDate || null,
          isCurrent: false, isPaused: requestedPaused, participantGranularity, createdBy: admin.id
        });
      }
    }
    const orgId = await getCurrentOrgId();
    if (id) await pubCache.invalidate(id, orgId);
    await sharedCache.invalidatePrefix('overview_' + orgId + '_');
    res.json({ status: 'success' });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// deleteScoreActivity
router.post('/deleteScoreActivity', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_4314b97854 });

    const orgId = await getCurrentOrgId();

    const outcome = await pool.withTransaction(async (conn) => {
      const [activityRows] = await conn.query(
        'SELECT id FROM score_activities WHERE id = ? AND org_id = ? FOR UPDATE',
        [id, orgId]
      );
      if (!activityRows[0]) return { status: 'not_found' };

      const [referenceRows] = await conn.query(
        `SELECT
           (SELECT COUNT(*) FROM score_records WHERE activity_id = ? AND org_id = ?) AS score_count,
           (SELECT COUNT(*) FROM result_publications WHERE activity_id = ? AND org_id = ?) AS publication_count`,
        [id, orgId, id, orgId]
      );
      const references = referenceRows[0] || {};
      if (Number(references.score_count || 0) > 0 || Number(references.publication_count || 0) > 0) {
        return { status: 'conflict' };
      }

      await conn.query(
        `DELETE FROM clause_template_configs
          WHERE org_id = ? AND clause_id IN (
            SELECT clause_row.id FROM rate_rule_clauses clause_row
            INNER JOIN rate_target_rules rule_row ON rule_row.id = clause_row.rule_id
            WHERE rule_row.activity_id = ? AND rule_row.org_id = ? AND clause_row.org_id = ?
          )`,
        [orgId, id, orgId, orgId]
      );
      await conn.query(
        `DELETE clause_row FROM rate_rule_clauses clause_row
          INNER JOIN rate_target_rules rule_row ON rule_row.id = clause_row.rule_id
         WHERE rule_row.activity_id = ? AND rule_row.org_id = ? AND clause_row.org_id = ?`,
        [id, orgId, orgId]
      );
      await conn.query(
        'DELETE FROM rate_target_rules WHERE activity_id = ? AND org_id = ?',
        [id, orgId]
      );
      await conn.query('DELETE FROM score_template_order WHERE activity_id = ?', [id]);
      await conn.query('DELETE FROM score_activities WHERE id = ? AND org_id = ?', [id, orgId]);
      return { status: 'success' };
    });

    if (outcome.status === 'not_found') {
      return res.json({ status: 'not_found', message: localeCopy.copy_4f0d449737 });
    }
    if (outcome.status === 'conflict') {
      return res.json({ status: 'conflict', message: scoringCopy.activityHasHistoricalData });
    }

    await pubCache.invalidate(id, orgId);
    await sharedCache.invalidatePrefix('overview_' + orgId + '_');
    res.json({ status: 'success' });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// setCurrentScoreActivity
router.post('/setCurrentScoreActivity', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_4314b97854 });

    const nowUtc = nowMysqlUtc();
    const orgId = await getCurrentOrgId();
    const found = await pool.withTransaction(async (conn) => {
      const [allActivities] = await conn.query(
        'SELECT id FROM score_activities WHERE org_id = ? ORDER BY id FOR UPDATE',
        [orgId]
      );
      if (!allActivities.some((item) => safeString(item.id) === id)) return false;
      await conn.query(
        `UPDATE score_activities
            SET is_current = CASE WHEN id = ? THEN 1 ELSE 0 END,
                updated_by = CASE WHEN id = ? THEN ? ELSE updated_by END,
                updated_at = CASE WHEN id = ? THEN ? ELSE updated_at END
          WHERE org_id = ?`,
        [id, id, admin.id, id, nowUtc, orgId]
      );
      return true;
    });
    if (!found) return res.json({ status: 'not_found', message: localeCopy.copy_4f0d449737 });
    await sharedCache.invalidatePrefix('overview_' + orgId + '_');
    res.json({ status: 'success' });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// getCurrentScoreActivity
router.post('/getCurrentScoreActivity', async (req, res) => {
  try {
    const item = await activityModel.getCurrent();
    if (!item) return res.json({ status: 'success', activity: null });

    function fmtDate(v) {
      if (!v) return '';
      const s = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      if (v instanceof Date && !isNaN(v)) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, '0');
        const d = String(v.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
      }
      return s.slice(0, 10);
    }
    res.json({
      status: 'success',
      activity: {
        id: item.id,
        name: item.name || '',
        description: item.description || '',
        startDate: fmtDate(item.start_date),
        endDate: fmtDate(item.end_date),
        isPaused: !!item.is_paused,
        participantGranularity: 'assignment'
      }
    });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// 用户查看结果时使用最近一次已发布活动。它与“当前评分活动”相互独立，
// 避免活动结束后历史结果和评优名单入口随 is_current 一起消失。
router.post('/getLatestPublishedScoreActivity', async (req, res) => {
  try {
    const item = await activityModel.getLatestPublished();
    res.json({
      status: 'success',
      activity: item ? {
        id: item.id,
        name: item.name || ''
      } : null
    });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// toggleActivityPause
router.post('/toggleActivityPause', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params', message: localeCopy.copy_4314b97854 });

    const activity = await activityModel.getById(id);
    if (!activity) return res.json({ status: 'not_found', message: localeCopy.copy_4f0d449737 });

    const newPaused = activity.is_paused ? 0 : 1;
    await activityModel.togglePause(id, newPaused);
    const orgId = await getCurrentOrgId();
    await sharedCache.invalidatePrefix('overview_' + orgId + '_');

    res.json({
      status: 'success',
      isPaused: !!newPaused,
      message: newPaused ? localeCopy.copy_122bce702a : localeCopy.copy_adb9a74154
    });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) || localeCopy.copy_0531ed9e78 });
  }
});

module.exports = router;
