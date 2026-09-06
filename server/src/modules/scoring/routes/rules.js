const localeCopy = require('../../../locales/zh-CN/generated/modules/scoring/routes/rules');
const scoringCopy = require('../../../locales/zh-CN/modules/scoring');
const { format: localeFormat } = require('../../../locales/runtime');
const express = require('express');
const router = express.Router();
const { safeString, generateId, buildNameMap } = require('../../../utils/helpers');
const { nowMysqlUtc } = require('../../../utils/dateTime');
const { resolveRequestAdmin: ensureAdmin } = require('../../../core/services/adminRequestContext');
const rateRuleModel = require('../models/rateRule');
const rateRuleClauseModel = require('../models/rateRuleClause');
const clauseTemplateConfigModel = require('../models/clauseTemplateConfig');
const departmentModel = require('../../../core/models/department');
const identityModel = require('../../../core/models/identity');
const activityModel = require('../models/scoreActivity');
const templateModel = require('../models/scoreTemplate');
const questionModel = require('../models/scoreQuestion');
const participantService = require('../services/participants');
const pool = require('../../../config/db');
const { withTransaction } = pool;
const { getCurrentOrgId } = require('../../../utils/orgContext');
const dictionaryUsage = require('../../../core/services/dictionaryUsage');

const RULE_SCOPE_LABEL_MAP = {
  same_department_identity: scoringCopy.scopeSameDepartmentIdentity,
  same_department_all: scoringCopy.scopeSameDepartmentAll,
  same_work_group_identity: scoringCopy.scopeSameWorkGroupIdentity,
  same_work_group_all: scoringCopy.scopeSameWorkGroupAll,
  identity_only: scoringCopy.scopeIdentityOnly,
  all_people: scoringCopy.scopeAllPeople
};

const VALID_SCOPES = ['same_department_identity', 'same_department_all', 'same_work_group_identity', 'same_work_group_all', 'identity_only', 'all_people'];
const IDENTITY_REQUIRED_SCOPES = ['same_department_identity', 'same_work_group_identity', 'identity_only'];
const VALID_CALCULATION_METHODS = ['weighted_average', 'trim_extremes'];
const MAX_BATCH_RULES = 200;

class RateRuleRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rejectRateRule(status, message) {
  throw new RateRuleRequestError(status, message);
}

function respondRateRuleError(res, error, fallbackMessage = scoringCopy.ruleOperationFailed) {
  return res.json({
    status: error instanceof RateRuleRequestError ? error.status : 'error',
    message: error instanceof RateRuleRequestError ? error.message : fallbackMessage
  });
}

async function loadRateRuleReference(connection, sql, params, message, status = 'invalid_params') {
  const [rows] = await connection.query(sql, params);
  if (!rows[0]) rejectRateRule(status, message);
  return rows[0];
}

async function normalizeRateRuleInput(connection, orgId, body) {
  const source = body || {};
  const id = safeString(source.id);
  const activityId = safeString(source.activityId);
  const scorerDepartmentId = safeString(source.scorerDepartmentId);
  const scorerIdentityId = safeString(source.scorerIdentityId);
  const allowSelfAssessment = !Object.prototype.hasOwnProperty.call(source, 'allowSelfAssessment')
    || source.allowSelfAssessment === true
    || source.allowSelfAssessment === 1
    || source.allowSelfAssessment === '1';
  const clauses = Array.isArray(source.clauses) ? source.clauses : [];
  const mode = safeString(source.mode) === 'replace' ? 'replace' : 'strict';

  if (!activityId || !scorerDepartmentId || !scorerIdentityId) {
    rejectRateRule('invalid_params', localeCopy.copy_aee0e7df2d);
  }
  if (!clauses.length) {
    rejectRateRule('invalid_params', scoringCopy.scoringRuleConfigInvalid);
  }

  const activity = await loadRateRuleReference(
    connection,
    'SELECT id, name FROM score_activities WHERE id = ? AND org_id = ? FOR UPDATE',
    [activityId, orgId],
    localeCopy.copy_4f0d449737
  );
  const scorerDepartment = await loadRateRuleReference(
    connection,
    'SELECT id, name FROM departments WHERE id = ? AND org_id = ? FOR UPDATE',
    [scorerDepartmentId, orgId],
    localeCopy.copy_c66dd9a783
  );
  const scorerIdentity = await loadRateRuleReference(
    connection,
    'SELECT id, name FROM identities WHERE id = ? AND org_id = ? FOR UPDATE',
    [scorerIdentityId, orgId],
    localeCopy.copy_c66dd9a783
  );
  let existingRule = null;
  if (id) {
    existingRule = await loadRateRuleReference(
      connection,
      `SELECT rule_row.*,
         (SELECT COUNT(*) FROM score_records record_row
           WHERE record_row.rule_id = rule_row.id AND record_row.org_id = rule_row.org_id) AS score_count
         FROM rate_target_rules rule_row
        WHERE rule_row.id = ? AND rule_row.org_id = ? FOR UPDATE`,
      [id, orgId],
      scoringCopy.scoringRuleNotFound,
      'rule_not_found'
    );
    if (Number(existingRule.score_count || 0) > 0
      && (safeString(existingRule.activity_id) !== activityId
        || safeString(existingRule.scorer_department_id) !== scorerDepartmentId
        || safeString(existingRule.scorer_identity_id) !== scorerIdentityId)) {
      rejectRateRule('rule_identity_locked', scoringCopy.scoringRuleIdentityLocked);
    }
  }

  const normalizedClauses = [];
  const targetIdentityIds = [];
  for (const clause of clauses) {
    const scopeType = safeString(clause.scopeType);
    if (!VALID_SCOPES.includes(scopeType)) {
      rejectRateRule('invalid_params', localeCopy.copy_1ddbd16012);
    }

    const targetIdentityId = IDENTITY_REQUIRED_SCOPES.includes(scopeType)
      ? safeString(clause.targetIdentityId)
      : '';
    if (IDENTITY_REQUIRED_SCOPES.includes(scopeType) && !targetIdentityId) {
      rejectRateRule('invalid_params', localeCopy.copy_ed94482d7f);
    }
    if (targetIdentityId) {
      await loadRateRuleReference(
        connection,
        'SELECT id FROM identities WHERE id = ? AND org_id = ? FOR UPDATE',
        [targetIdentityId, orgId],
        localeCopy.copy_ecdaddc1eb
      );
      targetIdentityIds.push(targetIdentityId);
    }

    const templateConfigs = [];
    const rawConfigs = Array.isArray(clause.templateConfigs)
      ? clause.templateConfigs
      : (clause.templateId
        ? [{ templateId: clause.templateId, weight: clause.weight || 1, sortOrder: clause.sortOrder || 1 }]
        : []);
    if (!rawConfigs.length) {
      rejectRateRule('invalid_params', scoringCopy.scoringRuleConfigInvalid);
    }
    const templateIdsInClause = new Set();
    for (const item of rawConfigs) {
      const templateId = safeString(item.templateId);
      if (!templateId || templateIdsInClause.has(templateId)) {
        rejectRateRule('invalid_params', scoringCopy.scoringRuleConfigInvalid);
      }
      templateIdsInClause.add(templateId);
      await loadRateRuleReference(
        connection,
        'SELECT id FROM score_question_templates WHERE id = ? AND org_id = ? FOR UPDATE',
        [templateId, orgId],
        localeCopy.copy_785b6d700c
      );
      const weight = Number(item.weight);
      const sortOrder = Number(item.sortOrder);
      const calculationMethod = safeString(item.calculationMethod) || 'weighted_average';
      const trimHighCount = Number(item.trimHighCount || 0);
      const trimLowCount = Number(item.trimLowCount || 0);
      if (!Number.isFinite(weight) || weight <= 0 || !Number.isInteger(sortOrder) || sortOrder <= 0
        || !VALID_CALCULATION_METHODS.includes(calculationMethod)
        || !Number.isInteger(trimHighCount) || trimHighCount < 0
        || !Number.isInteger(trimLowCount) || trimLowCount < 0
        || (calculationMethod === 'weighted_average' && (trimHighCount !== 0 || trimLowCount !== 0))) {
        rejectRateRule('invalid_params', localeCopy.copy_cd5cb36ed6);
      }
      templateConfigs.push({
        templateId,
        weight,
        sortOrder,
        calculationMethod,
        trimHighCount,
        trimLowCount
      });
    }
    templateConfigs.sort((left, right) => left.sortOrder - right.sortOrder);
    normalizedClauses.push({
      scopeType,
      targetIdentityId,
      requireAllComplete: clause.requireAllComplete === true,
      templateConfigs
    });
  }

  const dedupedClauses = [];
  const seenKeys = new Map();
  for (const clause of normalizedClauses) {
    const clauseKey = clause.scopeType + '::' + clause.targetIdentityId;
    const existingIndex = seenKeys.get(clauseKey);
    if (existingIndex !== undefined) {
      if (mode === 'replace') dedupedClauses[existingIndex] = clause;
      else rejectRateRule('duplicate_clause', localeCopy.copy_7fab232951);
    } else {
      seenKeys.set(clauseKey, dedupedClauses.length);
      dedupedClauses.push(clause);
    }
  }

  await dictionaryUsage.assertDictionaryReferences({
    organizationId: orgId,
    departmentIds: [scorerDepartmentId],
    identityCategoryIds: [scorerIdentityId].concat(targetIdentityIds),
    workGroupIds: [],
    connection
  });

  const [duplicateRows] = await connection.query(
    `SELECT id FROM rate_target_rules
      WHERE activity_id = ? AND scorer_key = ? AND org_id = ?
        AND (? = '' OR id <> ?)
      LIMIT 1 FOR UPDATE`,
    [activityId, scorerDepartmentId + '::' + scorerIdentityId, orgId, id, id]
  );
  if (duplicateRows[0] && (id || mode !== 'replace')) {
    rejectRateRule('duplicate_category', localeCopy.copy_b92191d8ca);
  }

  return {
    id,
    activityId,
    activityName: safeString(activity.name),
    scorerDepartmentId,
    scorerDepartmentName: safeString(scorerDepartment.name),
    scorerIdentityId,
    scorerIdentityName: safeString(scorerIdentity.name),
    scorerKey: scorerDepartmentId + '::' + scorerIdentityId,
    allowSelfAssessment,
    clauses: dedupedClauses,
    mode
  };
}

async function clearRateRuleClauses(connection, orgId, ruleId) {
  const [oldClauses] = await connection.query(
    'SELECT id FROM rate_rule_clauses WHERE rule_id = ? AND org_id = ? FOR UPDATE',
    [ruleId, orgId]
  );
  if (oldClauses.length) {
    await connection.query(
      'DELETE FROM clause_template_configs WHERE clause_id IN (?) AND org_id = ?',
      [oldClauses.map((clause) => clause.id), orgId]
    );
  }
  await connection.query('DELETE FROM rate_rule_clauses WHERE rule_id = ? AND org_id = ?', [ruleId, orgId]);
}

async function saveRateRuleWithConnection(connection, orgId, input) {
  const nowUtc = nowMysqlUtc();
  let ruleId = input.id;
  if (input.id) {
    const [rows] = await connection.query(
      'SELECT id FROM rate_target_rules WHERE id = ? AND org_id = ? FOR UPDATE',
      [input.id, orgId]
    );
    if (!rows[0]) rejectRateRule('rule_not_found', scoringCopy.scoringRuleNotFound);
    await connection.query(
      'UPDATE rate_target_rules SET activity_id = ?, scorer_department_id = ?, scorer_identity_id = ?, scorer_key = ?, is_active = 1, allow_self_assessment = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      [input.activityId, input.scorerDepartmentId, input.scorerIdentityId, input.scorerKey, input.allowSelfAssessment ? 1 : 0, nowUtc, ruleId, orgId]
    );
    await clearRateRuleClauses(connection, orgId, ruleId);
  } else {
    const [existingRows] = await connection.query(
      'SELECT id FROM rate_target_rules WHERE activity_id = ? AND scorer_key = ? AND org_id = ? FOR UPDATE',
      [input.activityId, input.scorerKey, orgId]
    );
    if (existingRows[0]) {
      if (input.mode !== 'replace') {
        rejectRateRule('duplicate_category', localeCopy.copy_b92191d8ca);
      }
      ruleId = existingRows[0].id;
      await connection.query(
        'UPDATE rate_target_rules SET activity_id = ?, scorer_department_id = ?, scorer_identity_id = ?, scorer_key = ?, is_active = 1, allow_self_assessment = ?, updated_at = ? WHERE id = ? AND org_id = ?',
        [input.activityId, input.scorerDepartmentId, input.scorerIdentityId, input.scorerKey, input.allowSelfAssessment ? 1 : 0, nowUtc, ruleId, orgId]
      );
      await clearRateRuleClauses(connection, orgId, ruleId);
    } else {
      ruleId = generateId();
      await connection.query(
        'INSERT INTO rate_target_rules (id, activity_id, scorer_department_id, scorer_identity_id, scorer_key, is_active, allow_self_assessment, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
        [ruleId, input.activityId, input.scorerDepartmentId, input.scorerIdentityId, input.scorerKey, input.allowSelfAssessment ? 1 : 0, orgId, nowUtc, nowUtc]
      );
    }
  }

  for (const clause of input.clauses) {
    const clauseId = generateId();
    await connection.query(
      'INSERT INTO rate_rule_clauses (id, rule_id, scope_type, target_identity_id, require_all_complete, org_id) VALUES (?, ?, ?, ?, ?, ?)',
      [clauseId, ruleId, clause.scopeType, clause.targetIdentityId, clause.requireAllComplete ? 1 : 0, orgId]
    );
    for (let index = 0; index < clause.templateConfigs.length; index++) {
      const config = clause.templateConfigs[index];
      await connection.query(
        'INSERT INTO clause_template_configs (id, clause_id, sort_order, template_id, weight, calculation_method, trim_high_count, trim_low_count, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [generateId(), clauseId, index + 1, config.templateId, config.weight, config.calculationMethod, config.trimHighCount || 0, config.trimLowCount || 0, orgId]
      );
    }
  }

  return {
    id: ruleId,
    rule: {
      id: ruleId,
      activityId: input.activityId,
      activityName: input.activityName,
      scorerDepartmentId: input.scorerDepartmentId,
      scorerDepartment: input.scorerDepartmentName,
      scorerIdentityId: input.scorerIdentityId,
      scorerIdentity: input.scorerIdentityName,
      allowSelfAssessment: input.allowSelfAssessment,
      clauses: input.clauses.map((clause) => ({ ...clause, targetIdentity: '' }))
    }
  };
}

function assertUniqueRateRuleBatch(items) {
  const ids = new Set();
  const keys = new Set();
  for (const item of items) {
    const key = item.activityId + '::' + item.scorerKey;
    if ((item.id && ids.has(item.id)) || keys.has(key)) {
      rejectRateRule('duplicate_batch_item', scoringCopy.batchDuplicateItem);
    }
    if (item.id) ids.add(item.id);
    keys.add(key);
  }
}

function getRateRuleBatch(body) {
  const rules = Array.isArray(body && body.rules) ? body.rules : [];
  if (!rules.length) rejectRateRule('invalid_params', scoringCopy.batchItemsRequired);
  if (rules.length > MAX_BATCH_RULES) {
    rejectRateRule('batch_limit_exceeded', localeFormat(scoringCopy.batchLimitExceeded, [MAX_BATCH_RULES]));
  }
  return rules;
}

async function fetchOrgLookups(orgId) {
  const [departments, identities, templates, activities] = await Promise.all([
    departmentModel.getAll(), identityModel.getAll(), templateModel.getAll(orgId), activityModel.getAll()
  ]);
  return {
    departmentsById: buildNameMap(departments),
    identitiesById: buildNameMap(identities),
    templatesById: buildNameMap(templates),
    activitiesById: buildNameMap(activities)
  };
}

function normalizeClause(clause, lookups) {
  const scopeType = safeString(clause.scopeType);
  const targetIdentityId = safeString(clause.targetIdentityId);
  const templateConfigs = Array.isArray(clause.templateConfigs) ? clause.templateConfigs : [];
  return {
    scopeType,
    scopeLabel: RULE_SCOPE_LABEL_MAP[scopeType] || scopeType,
    targetIdentityId,
    targetIdentity: targetIdentityId ? safeString(lookups.identitiesById.get(targetIdentityId)) : '',
    requireAllComplete: clause.requireAllComplete === true,
    templateConfigs: templateConfigs.map((item) => ({
      templateId: safeString(item.templateId),
      templateName: safeString(lookups.templatesById.get(safeString(item.templateId))),
      weight: Number(item.weight),
      sortOrder: Number(item.sortOrder),
      calculationMethod: safeString(item.calculationMethod) || 'weighted_average',
      trimHighCount: Number(item.trimHighCount || 0),
      trimLowCount: Number(item.trimLowCount || 0)
    })).sort((a, b) => a.sortOrder - b.sortOrder)
  };
}

function buildClauseText(clause) {
  const identityText = clause.targetIdentity
    ? localeFormat(scoringCopy.ruleClauseTargetIdentity, [clause.targetIdentity])
    : '';
  const completeText = clause.requireAllComplete
    ? scoringCopy.ruleClauseRequireAll
    : scoringCopy.ruleClauseAllowPartial;
  const questionText = clause.templateConfigs.length
    ? clause.templateConfigs.map((cfg) => localeFormat(scoringCopy.ruleClauseTemplateItem, [
      cfg.templateName || localeCopy.copy_a3c996a525,
      cfg.weight,
      cfg.sortOrder
    ])).join('、')
    : scoringCopy.ruleClauseNoTemplate;
  return (clause.scopeLabel || localeCopy.copy_f8d4dcaa31) + identityText + completeText + ' [' + questionText + ']';
}

// listRateRules
router.post('/listRateRules', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const activityId = safeString(req.body.activityId);
    const orgId = await getCurrentOrgId();
    const lookups = await fetchOrgLookups(orgId);

    const rules = activityId
      ? await rateRuleModel.getByActivity(activityId)
      : await rateRuleModel.getAll();

    const ruleIds = rules.map((r) => r.id);
    const allClauses = ruleIds.length ? await rateRuleClauseModel.getByRuleIds(ruleIds) : [];
    const clauseIds = allClauses.map((c) => c.id);
    const allConfigs = clauseIds.length ? await clauseTemplateConfigModel.getByClauseIds(clauseIds) : [];

    const clausesByRule = new Map();
    allClauses.forEach((c) => {
      if (!clausesByRule.has(c.rule_id)) clausesByRule.set(c.rule_id, []);
      clausesByRule.get(c.rule_id).push(c);
    });
    const configsByClause = new Map();
    allConfigs.forEach((cfg) => {
      if (!configsByClause.has(cfg.clause_id)) configsByClause.set(cfg.clause_id, []);
      configsByClause.get(cfg.clause_id).push(cfg);
    });

    const result = rules.map((item) => {
      const rawClauses = (clausesByRule.get(item.id) || []).map((c) => {
        const configs = (configsByClause.get(c.id) || []).map((cfg) => ({
          templateId: cfg.template_id,
          templateName: safeString(lookups.templatesById.get(cfg.template_id)),
          weight: Number(cfg.weight),
          sortOrder: Number(cfg.sort_order),
          calculationMethod: safeString(cfg.calculation_method) || 'weighted_average',
          trimHighCount: Number(cfg.trim_high_count || 0),
          trimLowCount: Number(cfg.trim_low_count || 0)
        })).sort((a, b) => a.sortOrder - b.sortOrder);
        return { scopeType: c.scope_type, targetIdentityId: c.target_identity_id, requireAllComplete: !!c.require_all_complete, templateConfigs: configs };
      });

      const clauses = rawClauses.map((clause) => normalizeClause(clause, lookups));
      return {
        id: item.id,
        activityId: item.activity_id,
        activityName: safeString(lookups.activitiesById.get(item.activity_id)),
        scorerDepartmentId: item.scorer_department_id,
        scorerDepartment: safeString(lookups.departmentsById.get(item.scorer_department_id)),
        scorerIdentityId: item.scorer_identity_id,
        scorerIdentity: safeString(lookups.identitiesById.get(item.scorer_identity_id)),
        allowSelfAssessment: item.allow_self_assessment !== 0,
        clauses,
        clausesText: clauses.length ? clauses.map((c) => buildClauseText(c)).join(' | ') : scoringCopy.ruleClauseNoScope
      };
    }).sort((a, b) => {
      if (a.scorerDepartment !== b.scorerDepartment) return a.scorerDepartment.localeCompare(b.scorerDepartment, 'zh-CN');
      return a.scorerIdentity.localeCompare(b.scorerIdentity, 'zh-CN');
    });

    res.json({ status: 'success', rules: result });
  } catch (e) {
    respondRateRuleError(res, e);
  }
});

// saveRateRule
router.post('/saveRateRule', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const orgId = await getCurrentOrgId();
    const result = await withTransaction(async (connection) => {
      const input = await normalizeRateRuleInput(connection, orgId, req.body);
      return saveRateRuleWithConnection(connection, orgId, input);
    });
    res.json({ status: 'success', id: result.id, rule: result.rule });
  } catch (e) {
    respondRateRuleError(res, e);
  }
});

// batchSaveRateRules
router.post('/batchSaveRateRules', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const rules = getRateRuleBatch(req.body);

    const orgId = await getCurrentOrgId();
    const results = await withTransaction(async (connection) => {
      const inputs = [];
      for (const rule of rules) inputs.push(await normalizeRateRuleInput(connection, orgId, rule));
      assertUniqueRateRuleBatch(inputs);
      const saved = [];
      for (const input of inputs) saved.push(await saveRateRuleWithConnection(connection, orgId, input));
      return saved;
    });
    res.json({ status: 'success', count: results.length, ids: results.map((item) => item.id) });
  } catch (e) {
    respondRateRuleError(res, e, scoringCopy.batchOperationFailed);
  }
});

// deleteRateRule
router.post('/deleteRateRule', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden' });

    const id = safeString(req.body.id);
    if (!id) return res.json({ status: 'invalid_params' });

    const orgId = await getCurrentOrgId();
    const outcome = await withTransaction(async (connection) => {
      const [ruleRows] = await connection.query(
        'SELECT id FROM rate_target_rules WHERE id = ? AND org_id = ? FOR UPDATE',
        [id, orgId]
      );
      if (!ruleRows[0]) return 'not_found';
      const [recordRows] = await connection.query(
        'SELECT 1 FROM score_records WHERE rule_id = ? AND org_id = ? LIMIT 1 FOR UPDATE',
        [id, orgId]
      );
      if (recordRows[0]) return 'referenced';
      await clearRateRuleClauses(connection, orgId, id);
      await connection.query('DELETE FROM rate_target_rules WHERE id = ? AND org_id = ?', [id, orgId]);
      return 'success';
    });

    if (outcome === 'not_found') {
      return res.json({ status: 'rule_not_found', message: scoringCopy.scoringRuleNotFound });
    }
    if (outcome === 'referenced') {
      return res.json({ status: 'conflict', message: scoringCopy.scoringRuleHasRecords });
    }
    res.json({ status: 'success' });
  } catch (e) {
    respondRateRuleError(res, e);
  }
});

// generateRateTargetRules
router.post('/generateRateTargetRules', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const activityId = safeString(req.body.activityId);
    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_21368b3e76 });
    const activity = await activityModel.getById(activityId);
    if (!activity) return res.json({ status: 'invalid_params', message: localeCopy.copy_4f0d449737 });

    const orgId = await getCurrentOrgId();
    const [assignmentRows, departments, identities] = await Promise.all([
      participantService.listParticipants(orgId, 'assignment'),
      departmentModel.getAll(),
      identityModel.getAll()
    ]);

    const deptMap = buildNameMap(departments);
    const identityMap = buildNameMap(identities);

    const categories = new Map();
    assignmentRows.forEach((item) => {
      const depId = safeString(item.department_id);
      const idId = safeString(item.identity_id);
      if (!depId || !idId) return;
      const scorerKey = depId + '::' + idId;
      if (!categories.has(scorerKey)) {
        categories.set(scorerKey, { activityId, scorerKey, scorerDepartmentId: depId, scorerIdentityId: idId, isActive: true });
      }
    });

    const outcome = await withTransaction(async (connection) => {
      await loadRateRuleReference(
        connection,
        'SELECT id FROM score_activities WHERE id = ? AND org_id = ? FOR UPDATE',
        [activityId, orgId],
        localeCopy.copy_4f0d449737
      );
      const [existingRules] = await connection.query(
        `SELECT * FROM rate_target_rules
          WHERE activity_id = ? AND org_id = ?
          ORDER BY created_at, id FOR UPDATE`,
        [activityId, orgId]
      );
      const ruleIds = existingRules.map((item) => safeString(item.id)).filter(Boolean);
      const referencedRuleIds = new Set();
      if (ruleIds.length) {
        const [scoreRows] = await connection.query(
          'SELECT id, rule_id FROM score_records WHERE rule_id IN (?) AND org_id = ? FOR UPDATE',
          [ruleIds, orgId]
        );
        scoreRows.forEach((row) => referencedRuleIds.add(safeString(row.rule_id)));
      }

      const rulesByKey = new Map();
      const unkeyedRules = [];
      existingRules.forEach((item) => {
        const key = safeString(item.scorer_key);
        if (!key) {
          unkeyedRules.push(item);
          return;
        }
        if (!rulesByKey.has(key)) rulesByKey.set(key, []);
        rulesByKey.get(key).push(item);
      });

      const survivorByKey = new Map();
      const removableRules = [];
      for (const [key, rows] of rulesByKey.entries()) {
        const referenced = rows.filter((item) => referencedRuleIds.has(safeString(item.id)));
        if (referenced.length > 1) {
          rejectRateRule('duplicate_rules_have_records', scoringCopy.scoringRuleDuplicatesHaveRecords);
        }
        const survivor = referenced[0] || rows[0];
        survivorByKey.set(key, survivor);
        rows.forEach((item) => {
          if (item !== survivor) removableRules.push(item);
        });
      }
      unkeyedRules.forEach((item) => {
        if (!referencedRuleIds.has(safeString(item.id))) removableRules.push(item);
      });

      for (const item of removableRules) {
        await clearRateRuleClauses(connection, orgId, item.id);
        await connection.query(
          'DELETE FROM rate_target_rules WHERE id = ? AND org_id = ?',
          [item.id, orgId]
        );
      }

      const rulesToAdd = [];
      for (const rule of categories.values()) {
        if (!survivorByKey.has(rule.scorerKey)) rulesToAdd.push(rule);
      }
      const nowUtc = nowMysqlUtc();
      for (const rule of rulesToAdd) {
        await connection.query(
          `INSERT INTO rate_target_rules
            (id, activity_id, scorer_department_id, scorer_identity_id, scorer_key,
             is_active, allow_self_assessment, org_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
          [generateId(), activityId, rule.scorerDepartmentId, rule.scorerIdentityId,
            rule.scorerKey, orgId, nowUtc, nowUtc]
        );
      }
      return {
        createdCount: rulesToAdd.length,
        removedDuplicateCount: removableRules.length
      };
    });

    res.json({
      status: 'success',
      collectionName: 'rate_target_rules',
      ruleCount: categories.size,
      createdCount: outcome.createdCount,
      keptCount: categories.size - outcome.createdCount,
      removedDuplicateCount: outcome.removedDuplicateCount,
      departmentsResolved: Array.from(categories.values()).filter((r) => deptMap.has(r.scorerDepartmentId)).length,
      identitiesResolved: Array.from(categories.values()).filter((r) => identityMap.has(r.scorerIdentityId)).length
    });
  } catch (e) {
    respondRateRuleError(res, e);
  }
});

module.exports = router;
