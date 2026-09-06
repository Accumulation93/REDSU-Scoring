const localeCopy = require('../../../locales/zh-CN/generated/modules/scoring/routes/publications');
const scoringCopy = require('../../../locales/zh-CN/modules/scoring');
const retiredCopy = require('../../../locales/zh-CN/generated/core/routes/admin');
const { format: localeFormat } = require('../../../locales/runtime');
const express = require('express');
const router = express.Router();
const notificationOutboxModel = require('../../audit/models/notificationOutbox');
const { safeString, toNumber, roundScore, generateId, buildNameMap } = require('../../../utils/helpers');
const { nowMysqlUtc } = require('../../../utils/dateTime');
const { logger } = require('../../../utils/logger');
const { resolveRequestAdmin: resolveAdmin } = require('../../../core/services/adminRequestContext');
const { getAuthenticatedContext } = require('../../../core/services/authenticatedContext');
const publicationModel = require('../models/resultPublication');
const designationModel = require('../models/meritListDesignation');
const departmentModel = require('../../../core/models/department');
const identityModel = require('../../../core/models/identity');
const workGroupModel = require('../../../core/models/workGroup');
const activityModel = require('../models/scoreActivity');
const scoreRecordModel = require('../models/scoreRecord');
const { buildWorkbookBuffer } = require('../../../utils/excelFile');
const pool = require('../../../config/db');
const { withTransaction } = pool;
const { getCurrentOrgId } = require('../../../utils/orgContext');
const pubCache = require('../utils/pubCache');
const { resolveCurrentActor } = require('../../../core/services/currentActor');
const participantService = require('../services/participants');
const publicationAssignments = require('../services/publicationAssignments');
const dictionaryUsage = require('../../../core/services/dictionaryUsage');
const unifiedIdentityModel = require('../../../core/models/unifiedIdentity');

const VALID_DISPLAY_MODES = ['score', 'grade'];
const VIEW_RULE_SCOPES = ['own_results', 'same_department_identity', 'same_department_all', 'same_work_group_identity', 'same_work_group_all', 'all_people'];
const VIEW_IDENTITY_REQUIRED_SCOPES = ['same_department_identity', 'same_work_group_identity'];
const MERIT_RULE_SCOPES = ['same_department_identity', 'same_department_all', 'same_work_group_identity', 'same_work_group_all', 'all_people', 'identity_only'];
const MAX_BATCH_RULES = 200;

class PublicationRuleRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rejectPublicationRule(status, message) {
  throw new PublicationRuleRequestError(status, message);
}

function respondPublicationRuleError(res, error, fallbackMessage = scoringCopy.ruleOperationFailed) {
  return res.json({
    status: error instanceof PublicationRuleRequestError ? error.status : 'error',
    message: error instanceof PublicationRuleRequestError ? error.message : fallbackMessage
  });
}

async function assertPublicationDictionaryReferences(connection, orgId, departmentId, identityIds) {
  try {
    await dictionaryUsage.assertDictionaryReferences({
      organizationId: orgId,
      departmentIds: [departmentId],
      identityCategoryIds: identityIds,
      workGroupIds: [],
      connection
    });
  } catch (error) {
    if (error && ['invalid_department_reference', 'invalid_identity_reference'].includes(error.code)) {
      rejectPublicationRule('invalid_params', scoringCopy.publicationRuleReferenceInvalid);
    }
    throw error;
  }
}

async function assertPublicationExists(connection, orgId, publicationId) {
  const [rows] = await connection.query(
    'SELECT id FROM result_publications WHERE id = ? AND org_id = ? FOR UPDATE',
    [publicationId, orgId]
  );
  if (!rows[0]) rejectPublicationRule('invalid_params', localeCopy.copy_c2ca4efbfa);
}

async function normalizePubViewRuleInput(connection, orgId, body) {
  const source = body || {};
  const id = safeString(source.id);
  const publicationId = safeString(source.publicationId);
  const granteeDepartmentId = safeString(source.granteeDepartmentId);
  const granteeIdentityId = safeString(source.granteeIdentityId);
  const clauses = Array.isArray(source.clauses) ? source.clauses : [];
  if (!publicationId || !granteeDepartmentId || !granteeIdentityId) {
    rejectPublicationRule('invalid_params', localeCopy.copy_f076819918);
  }
  await assertPublicationExists(connection, orgId, publicationId);
  if (id) {
    const [rows] = await connection.query(
      'SELECT id FROM pub_view_rules WHERE id = ? AND publication_id = ? AND org_id = ? FOR UPDATE',
      [id, publicationId, orgId]
    );
    if (!rows[0]) rejectPublicationRule('rule_not_found', scoringCopy.publicationRuleNotFound);
  }

  const dedupedClauses = [];
  const seen = new Set();
  for (const clause of clauses) {
    const scopeType = safeString(clause.scopeType);
    if (!VIEW_RULE_SCOPES.includes(scopeType)) {
      rejectPublicationRule('invalid_params', localeCopy.copy_7126caee7e);
    }
    const targetIdentityId = VIEW_IDENTITY_REQUIRED_SCOPES.includes(scopeType)
      ? safeString(clause.targetIdentityId)
      : '';
    if (VIEW_IDENTITY_REQUIRED_SCOPES.includes(scopeType) && !targetIdentityId) {
      rejectPublicationRule('invalid_params', localeCopy.copy_b1d535ef38);
    }
    const key = scopeType + '::' + targetIdentityId;
    if (seen.has(key)) continue;
    seen.add(key);

    const displayMode = VALID_DISPLAY_MODES.includes(safeString(clause.displayMode))
      ? safeString(clause.displayMode)
      : 'score';
    const gradeBands = [];
    const rawGradeBands = Array.isArray(clause.gradeBands) ? clause.gradeBands : [];
    if (displayMode === 'grade' && !rawGradeBands.length) {
      rejectPublicationRule('invalid_params', localeCopy.copy_6937c46b0a);
    }
    for (let index = 0; index < rawGradeBands.length; index++) {
      const gradeBand = rawGradeBands[index];
      const minScore = Number(gradeBand.minScore);
      const maxScore = Number(gradeBand.maxScore);
      const gradeName = safeString(gradeBand.gradeName || gradeBand.grade_name);
      if (!Number.isFinite(minScore) || !Number.isFinite(maxScore)) {
        rejectPublicationRule('invalid_params', localeFormat(localeCopy.copy_caaa205301, [index + 1]));
      }
      if (minScore > maxScore) {
        rejectPublicationRule('invalid_params', localeFormat(localeCopy.copy_36ab872bc9, [index + 1]));
      }
      if (!gradeName) {
        rejectPublicationRule('invalid_params', localeFormat(localeCopy.copy_35fa8f1d08, [index + 1]));
      }
      gradeBands.push({ minScore, maxScore, gradeName });
    }
    dedupedClauses.push({ scopeType, targetIdentityId, displayMode, gradeBands });
  }

  await assertPublicationDictionaryReferences(
    connection,
    orgId,
    granteeDepartmentId,
    [granteeIdentityId].concat(dedupedClauses.map((clause) => clause.targetIdentityId))
  );
  return {
    id,
    publicationId,
    granteeDepartmentId,
    granteeIdentityId,
    key: publicationId + '::' + granteeDepartmentId + '::' + granteeIdentityId,
    clauses: dedupedClauses
  };
}

async function savePubViewRuleWithConnection(connection, orgId, input) {
  const now = nowMysqlUtc();
  let ruleId = input.id;
  if (input.id) {
    const [rows] = await connection.query(
      'SELECT id FROM pub_view_rules WHERE id = ? AND publication_id = ? AND org_id = ? FOR UPDATE',
      [input.id, input.publicationId, orgId]
    );
    if (!rows[0]) rejectPublicationRule('rule_not_found', scoringCopy.publicationRuleNotFound);
    const [conflicts] = await connection.query(
      'SELECT id FROM pub_view_rules WHERE publication_id = ? AND grantee_department_id = ? AND grantee_identity_id = ? AND org_id = ? FOR UPDATE',
      [input.publicationId, input.granteeDepartmentId, input.granteeIdentityId, orgId]
    );
    if (conflicts[0] && safeString(conflicts[0].id) !== input.id) {
      rejectPublicationRule('duplicate_rule', scoringCopy.publicationRuleConflict);
    }
    await connection.query(
      'UPDATE pub_view_rules SET grantee_department_id = ?, grantee_identity_id = ?, updated_at = ? WHERE id = ? AND publication_id = ? AND org_id = ?',
      [input.granteeDepartmentId, input.granteeIdentityId, now, input.id, input.publicationId, orgId]
    );
  } else {
    const [existingRows] = await connection.query(
      'SELECT id FROM pub_view_rules WHERE publication_id = ? AND grantee_department_id = ? AND grantee_identity_id = ? AND org_id = ? FOR UPDATE',
      [input.publicationId, input.granteeDepartmentId, input.granteeIdentityId, orgId]
    );
    if (existingRows[0]) {
      ruleId = existingRows[0].id;
      await connection.query(
        'UPDATE pub_view_rules SET updated_at = ? WHERE id = ? AND publication_id = ? AND org_id = ?',
        [now, ruleId, input.publicationId, orgId]
      );
    } else {
      ruleId = generateId();
      await connection.query(
        'INSERT INTO pub_view_rules (id, publication_id, grantee_department_id, grantee_identity_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ruleId, input.publicationId, input.granteeDepartmentId, input.granteeIdentityId, orgId, now, now]
      );
    }
  }

  await connection.query('DELETE FROM pub_view_rule_clauses WHERE rule_id = ? AND org_id = ?', [ruleId, orgId]);
  for (let index = 0; index < input.clauses.length; index++) {
    const clause = input.clauses[index];
    const clauseId = generateId();
    await connection.query(
      'INSERT INTO pub_view_rule_clauses (id, rule_id, scope_type, target_identity_id, display_mode, sort_order, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [clauseId, ruleId, clause.scopeType, clause.targetIdentityId, clause.displayMode, index + 1, orgId]
    );
    for (let bandIndex = 0; bandIndex < clause.gradeBands.length; bandIndex++) {
      const gradeBand = clause.gradeBands[bandIndex];
      await connection.query(
        'INSERT INTO pub_grade_bands (id, clause_id, min_score, max_score, grade_name, sort_order, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [generateId(), clauseId, gradeBand.minScore, gradeBand.maxScore, gradeBand.gradeName, bandIndex + 1, orgId]
      );
    }
  }
  return ruleId;
}

async function normalizePubMeritRuleInput(connection, orgId, body) {
  const source = body || {};
  const id = safeString(source.id);
  const publicationId = safeString(source.publicationId);
  const granteeDepartmentId = safeString(source.granteeDepartmentId);
  const granteeIdentityId = safeString(source.granteeIdentityId);
  const clauses = Array.isArray(source.clauses) ? source.clauses : [];
  if (!publicationId || !granteeDepartmentId || !granteeIdentityId) {
    rejectPublicationRule('invalid_params', localeCopy.copy_f076819918);
  }
  await assertPublicationExists(connection, orgId, publicationId);
  if (id) {
    const [rows] = await connection.query(
      'SELECT id FROM pub_merit_rules WHERE id = ? AND publication_id = ? AND org_id = ? FOR UPDATE',
      [id, publicationId, orgId]
    );
    if (!rows[0]) rejectPublicationRule('rule_not_found', scoringCopy.publicationRuleNotFound);
  }

  const [viewRules] = await connection.query(
    'SELECT id FROM pub_view_rules WHERE publication_id = ? AND grantee_department_id = ? AND grantee_identity_id = ? AND org_id = ? FOR UPDATE',
    [publicationId, granteeDepartmentId, granteeIdentityId, orgId]
  );
  if (!viewRules[0]) rejectPublicationRule('no_view_rule', localeCopy.copy_a7a80cb635);
  const [viewClauses] = await connection.query(
    'SELECT id FROM pub_view_rule_clauses WHERE rule_id = ? AND org_id = ? FOR UPDATE',
    [viewRules[0].id, orgId]
  );
  if (!viewClauses.length) rejectPublicationRule('no_view_rule', localeCopy.copy_bb9abe11b7);

  const dedupedClauses = [];
  const seen = new Set();
  for (const clause of clauses) {
    const scopeType = safeString(clause.scopeType) || 'all_people';
    if (!MERIT_RULE_SCOPES.includes(scopeType)) {
      rejectPublicationRule('invalid_params', localeCopy.copy_4f983cb64d);
    }
    const targetIdentityId = safeString(clause.targetIdentityId);
    if (!targetIdentityId) rejectPublicationRule('invalid_params', localeCopy.copy_b1d535ef38);
    const key = scopeType + '::' + targetIdentityId;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedClauses.push({
      scopeType,
      targetIdentityId,
      quotaLimit: Math.max(0, parseInt(String(clause.quotaLimit), 10) || 0),
      requireExactQuota: clause.requireExactQuota === true
    });
  }

  await assertPublicationDictionaryReferences(
    connection,
    orgId,
    granteeDepartmentId,
    [granteeIdentityId].concat(dedupedClauses.map((clause) => clause.targetIdentityId))
  );
  return {
    id,
    publicationId,
    granteeDepartmentId,
    granteeIdentityId,
    key: publicationId + '::' + granteeDepartmentId + '::' + granteeIdentityId,
    clauses: dedupedClauses
  };
}

async function savePubMeritRuleWithConnection(connection, orgId, input) {
  const now = nowMysqlUtc();
  let ruleId = input.id;
  if (input.id) {
    const [rows] = await connection.query(
      'SELECT id FROM pub_merit_rules WHERE id = ? AND publication_id = ? AND org_id = ? FOR UPDATE',
      [input.id, input.publicationId, orgId]
    );
    if (!rows[0]) rejectPublicationRule('rule_not_found', scoringCopy.publicationRuleNotFound);
    const [conflicts] = await connection.query(
      'SELECT id FROM pub_merit_rules WHERE publication_id = ? AND grantee_department_id = ? AND grantee_identity_id = ? AND org_id = ? FOR UPDATE',
      [input.publicationId, input.granteeDepartmentId, input.granteeIdentityId, orgId]
    );
    if (conflicts[0] && safeString(conflicts[0].id) !== input.id) {
      rejectPublicationRule('duplicate_rule', scoringCopy.publicationRuleConflict);
    }
    await connection.query(
      'UPDATE pub_merit_rules SET grantee_department_id = ?, grantee_identity_id = ?, updated_at = ? WHERE id = ? AND publication_id = ? AND org_id = ?',
      [input.granteeDepartmentId, input.granteeIdentityId, now, input.id, input.publicationId, orgId]
    );
  } else {
    const [existingRows] = await connection.query(
      'SELECT id FROM pub_merit_rules WHERE publication_id = ? AND grantee_department_id = ? AND grantee_identity_id = ? AND org_id = ? FOR UPDATE',
      [input.publicationId, input.granteeDepartmentId, input.granteeIdentityId, orgId]
    );
    if (existingRows[0]) {
      ruleId = existingRows[0].id;
      await connection.query(
        'UPDATE pub_merit_rules SET updated_at = ? WHERE id = ? AND publication_id = ? AND org_id = ?',
        [now, ruleId, input.publicationId, orgId]
      );
    } else {
      ruleId = generateId();
      await connection.query(
        'INSERT INTO pub_merit_rules (id, publication_id, grantee_department_id, grantee_identity_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ruleId, input.publicationId, input.granteeDepartmentId, input.granteeIdentityId, orgId, now, now]
      );
    }
  }

  const [oldClauses] = await connection.query(
    'SELECT id, scope_type, target_identity_id FROM pub_merit_rule_clauses WHERE rule_id = ? AND org_id = ? FOR UPDATE',
    [ruleId, orgId]
  );
  const oldByKey = new Map();
  oldClauses.forEach((clause) => {
    oldByKey.set(safeString(clause.scope_type) + '::' + safeString(clause.target_identity_id), clause);
  });
  const keptClauseIds = new Set();
  for (let index = 0; index < input.clauses.length; index++) {
    const clause = input.clauses[index];
    const key = clause.scopeType + '::' + clause.targetIdentityId;
    const oldClause = oldByKey.get(key);
    if (oldClause) {
      keptClauseIds.add(oldClause.id);
      await connection.query(
        'UPDATE pub_merit_rule_clauses SET quota_limit = ?, require_exact_quota = ?, sort_order = ?, scope_type = ?, updated_at = ? WHERE id = ? AND rule_id = ? AND org_id = ?',
        [clause.quotaLimit, clause.requireExactQuota ? 1 : 0, index + 1, clause.scopeType, now, oldClause.id, ruleId, orgId]
      );
    } else {
      const clauseId = generateId();
      keptClauseIds.add(clauseId);
      await connection.query(
        'INSERT INTO pub_merit_rule_clauses (id, rule_id, scope_type, target_identity_id, quota_limit, require_exact_quota, sort_order, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [clauseId, ruleId, clause.scopeType, clause.targetIdentityId, clause.quotaLimit, clause.requireExactQuota ? 1 : 0, index + 1, orgId]
      );
    }
  }
  const removedClauseIds = oldClauses
    .filter((oldClause) => !keptClauseIds.has(oldClause.id))
    .map((oldClause) => oldClause.id);
  await assertMeritClausesHaveNoDesignations(connection, orgId, removedClauseIds);
  for (const oldClauseId of removedClauseIds) {
    await connection.query(
      'DELETE FROM pub_merit_rule_clauses WHERE id = ? AND rule_id = ? AND org_id = ?',
      [oldClauseId, ruleId, orgId]
    );
  }
  return ruleId;
}

async function assertMeritClausesHaveNoDesignations(connection, orgId, clauseIds) {
  const ids = [...new Set((clauseIds || []).map(safeString).filter(Boolean))];
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await connection.query(
    `SELECT id FROM merit_list_designations
      WHERE clause_id IN (${placeholders}) AND org_id = ?
      LIMIT 1 FOR UPDATE`,
    [...ids, orgId]
  );
  if (rows[0]) {
    rejectPublicationRule('rule_has_designations', scoringCopy.publicationRuleHasDesignations);
  }
}

function assertUniquePublicationRuleBatch(items) {
  const ids = new Set();
  const keys = new Set();
  for (const item of items) {
    if ((item.id && ids.has(item.id)) || keys.has(item.key)) {
      rejectPublicationRule('duplicate_batch_item', scoringCopy.batchDuplicateItem);
    }
    if (item.id) ids.add(item.id);
    keys.add(item.key);
  }
}

async function deletePubViewRuleWithConnection(connection, orgId, ruleId, options = {}) {
  const [rows] = await connection.query(
    `SELECT id, publication_id, grantee_department_id, grantee_identity_id
       FROM pub_view_rules WHERE id = ? AND org_id = ? FOR UPDATE`,
    [ruleId, orgId]
  );
  if (!rows[0]) {
    if (options.requireExisting) {
      rejectPublicationRule('rule_not_found', scoringCopy.publicationRuleNotFound);
    }
    return false;
  }
  const rule = rows[0];
  const [dependentMeritRules] = await connection.query(
    `SELECT id FROM pub_merit_rules
      WHERE publication_id = ? AND grantee_department_id = ?
        AND grantee_identity_id = ? AND org_id = ?
      LIMIT 1 FOR UPDATE`,
    [rule.publication_id, rule.grantee_department_id, rule.grantee_identity_id, orgId]
  );
  if (dependentMeritRules[0]) {
    rejectPublicationRule('rule_in_use', scoringCopy.publicationViewRuleHasMeritRule);
  }
  await connection.query('DELETE FROM pub_view_rule_clauses WHERE rule_id = ? AND org_id = ?', [ruleId, orgId]);
  await connection.query('DELETE FROM pub_view_rules WHERE id = ? AND org_id = ?', [ruleId, orgId]);
  return true;
}

async function deletePubMeritRuleWithConnection(connection, orgId, ruleId, options = {}) {
  const [rows] = await connection.query(
    'SELECT id FROM pub_merit_rules WHERE id = ? AND org_id = ? FOR UPDATE',
    [ruleId, orgId]
  );
  if (!rows[0]) {
    if (options.requireExisting) {
      rejectPublicationRule('rule_not_found', scoringCopy.publicationRuleNotFound);
    }
    return false;
  }
  const [clauses] = await connection.query(
    'SELECT id FROM pub_merit_rule_clauses WHERE rule_id = ? AND org_id = ? FOR UPDATE',
    [ruleId, orgId]
  );
  await assertMeritClausesHaveNoDesignations(connection, orgId, clauses.map((clause) => clause.id));
  await connection.query('DELETE FROM pub_merit_rule_clauses WHERE rule_id = ? AND org_id = ?', [ruleId, orgId]);
  await connection.query('DELETE FROM pub_merit_rules WHERE id = ? AND org_id = ?', [ruleId, orgId]);
  return true;
}

function getPublicationRuleBatch(body) {
  const rules = Array.isArray(body && body.rules) ? body.rules : [];
  if (!rules.length) rejectPublicationRule('invalid_params', scoringCopy.batchItemsRequired);
  if (rules.length > MAX_BATCH_RULES) {
    rejectPublicationRule('batch_limit_exceeded', localeFormat(scoringCopy.batchLimitExceeded, [MAX_BATCH_RULES]));
  }
  return rules;
}

function getPublicationRuleIdBatch(body) {
  const rawRuleIds = Array.isArray(body && body.ruleIds) ? body.ruleIds : [];
  if (!rawRuleIds.length) rejectPublicationRule('invalid_params', scoringCopy.batchItemsRequired);
  if (rawRuleIds.length > MAX_BATCH_RULES) {
    rejectPublicationRule('batch_limit_exceeded', localeFormat(scoringCopy.batchLimitExceeded, [MAX_BATCH_RULES]));
  }
  const ruleIds = [...new Set(rawRuleIds.map(safeString).filter(Boolean))];
  if (!ruleIds.length) rejectPublicationRule('invalid_params', scoringCopy.batchItemsRequired);
  return ruleIds;
}

/**
 * Apply grade bands to a numeric score. Returns the first matching grade name,
 * or '未评级' if no band matches. Bands must be sorted by sort_order ascending.
 */
function applyGradeBands(score, bands) {
  if (!Array.isArray(bands) || !bands.length) return localeCopy.copy_201bb379be;
  // Ensure numeric comparison (defensive: score may come as string from some paths)
  const numScore = Number(score);
  if (!Number.isFinite(numScore)) return localeCopy.copy_201bb379be;
  for (const band of bands) {
    const minScore = Number(band.minScore != null ? band.minScore : band.min_score);
    const maxScore = Number(band.maxScore != null ? band.maxScore : band.max_score);
    if (!Number.isFinite(minScore) || !Number.isFinite(maxScore)) continue;
    if (numScore >= minScore && numScore <= maxScore) {
      return band.gradeName || band.grade_name || '';
    }
  }
  // Debug: log when a score doesn't match any band (helps catch config mismatches)
  logger.debug('No grade band matched', { numScore, bandCount: bands.length });
  return localeCopy.copy_201bb379be;
}

function rejectRetiredEndpoint(res) {
  return res.status(410).json({
    status: 'legacy_api_retired',
    message: retiredCopy.copy_0429e2ed3a
  });
}

// 部门、身份和职能组按组织缓存，禁止不同组织共享同一进程缓存。
const _orgLookupsCache = new Map();
const ORG_LOOKUPS_CACHE_TTL = 60000; // 60 seconds

async function fetchOrgLookups() {
  const orgId = await getCurrentOrgId();
  const now = Date.now();
  const cached = _orgLookupsCache.get(orgId);
  if (cached && (now - cached.timestamp) < ORG_LOOKUPS_CACHE_TTL) return cached.value;
  const [departments, identities, workGroups] = await Promise.all([
    departmentModel.getAll(), identityModel.getAll(), workGroupModel.getAll()
  ]);
  const value = { departmentsById: buildNameMap(departments), identitiesById: buildNameMap(identities), workGroupsById: buildNameMap(workGroups) };
  _orgLookupsCache.set(orgId, { value, timestamp: now });
  return value;
}

function getDesignationTargetIds(body) {
  const source = Array.isArray(body && body.designationAssignmentIds)
    ? body.designationAssignmentIds
    : (Array.isArray(body && body.designationHrIds) ? body.designationHrIds : []);
  return [...new Set(source.map(safeString).filter(Boolean))];
}

async function assertDesignationTargetsAvailable(connection, orgId, publicationId, clauseIds, targets) {
  const assignments = Array.isArray(targets) ? targets : [];
  if (!assignments.length) return;
  const excludedClauseIds = [...new Set((clauseIds || []).map(safeString).filter(Boolean))];
  const assignmentIds = assignments.map(publicationAssignments.assignmentIdOf).filter(Boolean);
  const legacyHrIds = [...new Set(assignments.map(publicationAssignments.legacyHrIdOf).filter(Boolean))];
  const assignmentPlaceholders = assignmentIds.map(() => '?').join(',');
  const legacyCondition = legacyHrIds.length
    ? ` OR (target_assignment_id IS NULL AND target_hr_id IN (${legacyHrIds.map(() => '?').join(',')}))`
    : '';
  const clauseCondition = excludedClauseIds.length
    ? ` AND clause_id NOT IN (${excludedClauseIds.map(() => '?').join(',')})`
    : '';
  const [rows] = await connection.query(
    `SELECT id FROM merit_list_designations
      WHERE publication_id = ? AND org_id = ?
        AND (target_assignment_id IN (${assignmentPlaceholders})${legacyCondition})
        ${clauseCondition}
      LIMIT 1 FOR UPDATE`,
    [publicationId, orgId, ...assignmentIds, ...legacyHrIds, ...excludedClauseIds]
  );
  if (rows[0]) {
    rejectPublicationRule('designation_conflict', scoringCopy.designationAlreadyAssigned);
  }
}

function buildDesignationPresentations(designations, lookups) {
  const rows = Array.isArray(designations) ? designations : [];
  return rows.map((designation) => publicationAssignments.buildDesignationPresentation(
    designation,
    lookups
  ));
}

function buildDesignatorSnapshot(req, actor, assignment) {
  const actorData = actor || {};
  const contextId = safeString(actorData.contextId || req.authContext && req.authContext.contextId);
  if (assignment) {
    return Object.assign(
      { role: safeString(actorData.type) || 'user' },
      participantService.buildAssignmentSnapshot(assignment, { contextId })
    );
  }
  return {
    contextId,
    role: safeString(actorData.type) || 'admin',
    personId: safeString(actorData.personId || req.authContext && req.authContext.personId),
    assignmentId: safeString(actorData.assignmentId || req.authContext && req.authContext.assignmentId),
    name: safeString(actorData.name)
  };
}

// ─── getResultPublication ───
router.post('/getResultPublication', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const activityId = safeString(req.body.activityId);
    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_21368b3e76 });

    const publication = await publicationModel.getByActivity(activityId);
    if (!publication) {
      return res.json({ status: 'success', publication: null, viewRules: [], meritRules: [], meritListDesignations: [] });
    }

    const orgId = await getCurrentOrgId();
    const pubId = publication.id;

    // Query new tables
    const [viewRuleRows] = await pool.query(
      'SELECT * FROM pub_view_rules WHERE publication_id = ? AND org_id = ?', [pubId, orgId]
    );
    const [meritRuleRows] = await pool.query(
      'SELECT * FROM pub_merit_rules WHERE publication_id = ? AND org_id = ?', [pubId, orgId]
    );
    const [designationRows] = await pool.query(
      'SELECT * FROM merit_list_designations WHERE publication_id = ? AND org_id = ?', [pubId, orgId]
    );

    // Fetch clauses
    const viewClausesMap = new Map();
    if (viewRuleRows.length > 0) {
      const ids = viewRuleRows.map(r => r.id);
      const ph = ids.map(() => '?').join(',');
      const [clauses] = await pool.query(
        `SELECT * FROM pub_view_rule_clauses WHERE rule_id IN (${ph}) AND org_id = ? ORDER BY sort_order ASC`,
        [...ids, orgId]
      );
      clauses.forEach(c => {
        if (!viewClausesMap.has(c.rule_id)) viewClausesMap.set(c.rule_id, []);
        viewClausesMap.get(c.rule_id).push(c);
      });
    }

    const meritClausesMap = new Map();
    if (meritRuleRows.length > 0) {
      const ids = meritRuleRows.map(r => r.id);
      const ph = ids.map(() => '?').join(',');
      const [clauses] = await pool.query(
        `SELECT * FROM pub_merit_rule_clauses WHERE rule_id IN (${ph}) AND org_id = ? ORDER BY sort_order ASC`,
        [...ids, orgId]
      );
      clauses.forEach(c => {
        if (!meritClausesMap.has(c.rule_id)) meritClausesMap.set(c.rule_id, []);
        meritClausesMap.get(c.rule_id).push(c);
      });
    }

    const [lookups, activeAssignments] = await Promise.all([
      fetchOrgLookups(),
      participantService.listParticipants(orgId, 'assignment')
    ]);
    const scopeLabelMap = {
      own_results: scoringCopy.scopeOwnResults,
      same_department_identity: scoringCopy.scopeViewSameDepartmentIdentity,
      same_department_all: scoringCopy.scopeViewSameDepartmentAll,
      same_work_group_identity: scoringCopy.scopeViewSameWorkGroupIdentity,
      same_work_group_all: scoringCopy.scopeViewSameWorkGroupAll,
      all_people: scoringCopy.scopeViewAllPeople,
      identity_only: scoringCopy.scopeViewIdentityOnly
    };

    // Load grade bands for all view clauses in one batch (per-clause level)
    const gradeBandsByClause = new Map();
    const allClauseIds = [];
    for (const clauses of viewClausesMap.values()) {
      for (const c of clauses) allClauseIds.push(c.id);
    }
    if (allClauseIds.length > 0) {
      const ph = allClauseIds.map(() => '?').join(',');
      try {
        const [allGradeBands] = await pool.query(
          `SELECT * FROM pub_grade_bands WHERE clause_id IN (${ph}) AND org_id = ? ORDER BY clause_id, sort_order ASC`,
          [...allClauseIds, orgId]
        );
        allGradeBands.forEach(gb => {
          if (!gradeBandsByClause.has(gb.clause_id)) gradeBandsByClause.set(gb.clause_id, []);
          gradeBandsByClause.get(gb.clause_id).push({
            id: gb.id, clauseId: gb.clause_id,
            minScore: Number(gb.min_score), maxScore: Number(gb.max_score),
            gradeName: safeString(gb.grade_name), sortOrder: gb.sort_order
          });
        });
      } catch (e) {
        // Table may not exist yet — grade bands will be empty
        req.logger && req.logger.warn('Failed to load grade bands', { error: e.message });
      }
    }

    const enrichedViewRules = viewRuleRows.map(r => {
      const clauses = (viewClausesMap.get(r.id) || []).map(c => ({
        id: c.id, ruleId: c.rule_id, scopeType: c.scope_type,
        scopeLabel: scopeLabelMap[c.scope_type] || c.scope_type,
        targetIdentityId: c.target_identity_id || '',
        targetIdentity: lookups.identitiesById.get(safeString(c.target_identity_id || '')) || '',
        displayMode: safeString(c.display_mode) || 'score',
        gradeBands: gradeBandsByClause.get(c.id) || [],
        sortOrder: c.sort_order
      }));
      return {
        id: r.id, publicationId: r.publication_id,
        granteeDepartmentId: r.grantee_department_id,
        granteeDepartment: lookups.departmentsById.get(safeString(r.grantee_department_id)) || '',
        granteeIdentityId: r.grantee_identity_id,
        granteeIdentity: lookups.identitiesById.get(safeString(r.grantee_identity_id)) || '',
        clauseCount: clauses.length, clauses
      };
    });

    const enrichedMeritRules = meritRuleRows.map(r => {
      const clauses = (meritClausesMap.get(r.id) || []).map(c => ({
        id: c.id, ruleId: c.rule_id, scopeType: c.scope_type,
        scopeLabel: scopeLabelMap[c.scope_type] || c.scope_type,
        targetIdentityId: c.target_identity_id || '',
        targetIdentity: lookups.identitiesById.get(safeString(c.target_identity_id || '')) || '',
        quotaLimit: c.quota_limit || 0, requireExactQuota: (c.require_exact_quota === 1),
        sortOrder: c.sort_order
      }));
      return {
        id: r.id, publicationId: r.publication_id,
        granteeDepartmentId: r.grantee_department_id,
        granteeDepartment: lookups.departmentsById.get(safeString(r.grantee_department_id)) || '',
        granteeIdentityId: r.grantee_identity_id,
        granteeIdentity: lookups.identitiesById.get(safeString(r.grantee_identity_id)) || '',
        clauseCount: clauses.length, clauses
      };
    });

    // 指定记录优先使用写入时岗位快照；离任、调岗后仍保留历史展示。
    const designationPresentations = buildDesignationPresentations(designationRows, lookups);
    const enrichedDesignations = designationPresentations.map((item, index) => ({
      ...item,
      publicationId: designationRows[index].publication_id,
      targetName: item.name,
      targetStudentId: item.studentId,
      designatedBy: designationRows[index].designated_by
    }));
    const assignmentCandidates = activeAssignments.map((assignment) => ({
      id: publicationAssignments.assignmentIdOf(assignment),
      assignmentId: publicationAssignments.assignmentIdOf(assignment),
      targetHrId: publicationAssignments.legacyHrIdOf(assignment),
      personId: safeString(assignment.person_id),
      name: safeString(assignment.name),
      studentId: safeString(assignment.student_id),
      departmentId: safeString(assignment.department_id),
      department: lookups.departmentsById.get(safeString(assignment.department_id)) || '',
      identityId: safeString(assignment.identity_id),
      identity: lookups.identitiesById.get(safeString(assignment.identity_id)) || '',
      workGroupId: safeString(assignment.work_group_id),
      workGroup: lookups.workGroupsById.get(safeString(assignment.work_group_id)) || '',
      assignmentLabel: publicationAssignments.buildAssignmentLabel(assignment, lookups)
    })).filter((assignment) => assignment.assignmentId);

    res.json({
      status: 'success',
      publication: { id: pubId, activityId: publication.activity_id, isPublished: !!publication.is_published, publishedAt: publication.published_at, publishedBy: publication.published_by },
      viewRules: enrichedViewRules, meritRules: enrichedMeritRules,
      meritListDesignations: enrichedDesignations, assignmentCandidates
    });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── saveResultPublication ───
router.post('/saveResultPublication', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const activityId = safeString(req.body.activityId);
    const isPublished = req.body.isPublished === true || req.body.isPublished === 1;
    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_21368b3e76 });

    const now = nowMysqlUtc();
    const orgId = await getCurrentOrgId();
    const outcome = await withTransaction(async (connection) => {
      const [activityRows] = await connection.query(
        'SELECT id, name FROM score_activities WHERE id = ? AND org_id = ? FOR UPDATE',
        [activityId, orgId]
      );
      const activity = activityRows[0];
      if (!activity) return null;
      const [publicationRows] = await connection.query(
        'SELECT * FROM result_publications WHERE activity_id = ? AND org_id = ? FOR UPDATE',
        [activityId, orgId]
      );
      const existing = publicationRows[0] || null;
      const wasPublished = !!(existing && existing.is_published);
      const publicationId = existing ? existing.id : generateId();
      if (existing) {
        await connection.query(
          `UPDATE result_publications
              SET is_published = ?, published_at = ?, published_by = ?, updated_at = ?
            WHERE id = ? AND org_id = ?`,
          [isPublished ? 1 : 0, isPublished ? now : existing.published_at,
            admin.id, now, publicationId, orgId]
        );
      } else {
        await connection.query(
          `INSERT INTO result_publications
            (id, activity_id, is_published, published_at, published_by, org_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [publicationId, activityId, isPublished ? 1 : 0,
            isPublished ? now : null, admin.id, orgId]
        );
      }
      if (isPublished && !wasPublished) {
        await notificationOutboxModel.enqueue({
          orgId,
          eventType: 'score_results_published',
          eventKey: 'score-results-published:' + publicationId + ':' + now,
          payload: {
            type: 'score_results_published',
            title: localeCopy.copy_a2fd08aa5b,
            description: localeFormat(scoringCopy.publicationNotificationDescription, [
              safeString(activity.name || localeCopy.copy_d8026f6068)
            ]),
            category: 'scoring',
            targetType: 'result_publication',
            targetId: publicationId,
            targetUrl: '/subpackages/workspace/pages/home/home?subApp=scoring',
            publicationId
          }
        }, connection);
      }
      return { id: publicationId };
    });
    if (!outcome) return res.json({ status: 'not_found', message: localeCopy.copy_4f0d449737 });
    res.json({
      status: 'success',
      publication: { id: outcome.id, activityId, isPublished },
      message: isPublished ? localeCopy.copy_912e2f8389 : localeCopy.copy_250c8669f1
    });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── saveResultViewPermission ───
router.post('/saveResultViewPermission', (req, res) => {
  return rejectRetiredEndpoint(res);
});

// ─── deleteResultViewPermission ───
router.post('/deleteResultViewPermission', (req, res) => {
  return rejectRetiredEndpoint(res);
});

// ─── saveMeritListPermission ───
router.post('/saveMeritListPermission', (req, res) => {
  return rejectRetiredEndpoint(res);
});

// ─── deleteMeritListPermission ───
router.post('/deleteMeritListPermission', (req, res) => {
  return rejectRetiredEndpoint(res);
});

// ─── saveMeritListDesignations ───
router.post('/saveMeritListDesignations', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const clauseIds = Array.isArray(req.body.clauseIds) && req.body.clauseIds.length
      ? req.body.clauseIds.map(id => safeString(id)).filter(Boolean)
      : [safeString(req.body.clauseId) || safeString(req.body.permissionId)];
    const primaryClauseId = clauseIds[0];
    const publicationId = safeString(req.body.publicationId);
    // 新客户端提交岗位 ID；旧 HR ID 仅在该人员当前只有一个岗位时兼容。
    const designationTargetIds = getDesignationTargetIds(req.body);

    if (!primaryClauseId || !publicationId) return res.json({ status: 'invalid_params', message: localeCopy.copy_157f5cd8f8 });

    // Look up clause + parent merit rule from new tables (include publication_id for reliable INSERT)
    const orgId = await getCurrentOrgId();
    const [[clause]] = await pool.query(
      `SELECT pmrc.*, pmr.grantee_department_id, pmr.grantee_identity_id, pmr.publication_id
         FROM pub_merit_rule_clauses pmrc
         JOIN pub_merit_rules pmr ON pmr.id = pmrc.rule_id
        WHERE pmrc.id = ? AND pmrc.org_id = ? AND pmr.org_id = ? AND pmr.publication_id = ?`,
      [primaryClauseId, orgId, orgId, publicationId]
    );
    if (!clause) return res.json({ status: 'not_found', message: localeCopy.copy_22d72751cb });

    // Admin can designate fewer than quota but NOT exceed it
    // Aggregate quota across all clauses
    let aggregatedQuotaLimit = 0;
    if (clauseIds.length > 1) {
      const ph = clauseIds.map(() => '?').join(',');
      const [quotaRows] = await pool.query(
        `SELECT quota_limit FROM pub_merit_rule_clauses WHERE id IN (${ph}) AND rule_id = ? AND org_id = ?`,
        [...clauseIds, clause.rule_id, orgId]
      );
      if (quotaRows.length !== clauseIds.length) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_7bd7eb5da6 });
      }
      for (const cl of quotaRows) {
        aggregatedQuotaLimit = Math.max(aggregatedQuotaLimit, cl.quota_limit || 0);
      }
    } else {
      aggregatedQuotaLimit = clause.quota_limit || 0;
    }
    const pubId = safeString(clause.publication_id) || publicationId;

    // Validate all designated HR members are within the ALL clauses' combined scope
    // Fetch all clause scopes in a single query
    let allClauseScopes = [];
    if (clauseIds.length > 1) {
      const ph = clauseIds.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT pmrc.scope_type, pmrc.target_identity_id,
                pmr.grantee_department_id, pmr.grantee_identity_id
           FROM pub_merit_rule_clauses pmrc
           JOIN pub_merit_rules pmr ON pmr.id = pmrc.rule_id
          WHERE pmrc.id IN (${ph}) AND pmrc.rule_id = ?
            AND pmrc.org_id = ? AND pmr.org_id = ? AND pmr.publication_id = ?`,
        [...clauseIds, clause.rule_id, orgId, orgId, publicationId]
      );
      if (rows.length !== clauseIds.length) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_7bd7eb5da6 });
      }
      allClauseScopes = rows;
    } else {
      allClauseScopes = [{
        scope_type: clause.scope_type,
        target_identity_id: clause.target_identity_id,
        grantee_department_id: clause.grantee_department_id,
        grantee_identity_id: clause.grantee_identity_id
      }];
    }
    const activeAssignments = await participantService.listParticipants(orgId, 'assignment');
    const resolvedTargets = publicationAssignments.resolveRequestedAssignments(designationTargetIds, activeAssignments);
    if (!resolvedTargets.ok) {
      return res.json({ status: 'invalid_hr', reason: resolvedTargets.status, message: localeCopy.copy_f3dd2d1ffc });
    }
    const designationTargets = resolvedTargets.targets;
    if (aggregatedQuotaLimit > 0 && designationTargets.length > aggregatedQuotaLimit) {
      return res.json({ status: 'quota_exceeded', message: localeFormat(localeCopy.copy_7010de3cee, [aggregatedQuotaLimit]) });
    }
    for (const targetAssignment of designationTargets) {
      let matchesAnyClause = false;
      for (const sc of allClauseScopes) {
        const granteeAssignments = activeAssignments.filter((assignment) => (
          safeString(assignment.department_id) === safeString(sc.grantee_department_id)
          && safeString(assignment.identity_id) === safeString(sc.grantee_identity_id)
        ));
        matchesAnyClause = granteeAssignments.some((granteeAssignment) => (
          publicationAssignments.matchesMeritClause(targetAssignment, sc, granteeAssignment)
        ));
        if (matchesAnyClause) break;
      }
      if (!matchesAnyClause) {
        const displayName = safeString(targetAssignment.name) || publicationAssignments.assignmentIdOf(targetAssignment);
        return res.json({ status: 'out_of_scope', message: localeFormat(localeCopy.copy_45ccfd7d80, [displayName]) });
      }
    }

    const designatorSnapshot = buildDesignatorSnapshot(req, {
      type: 'admin',
      personId: req.authContext && req.authContext.personId,
      assignmentId: req.authContext && req.authContext.assignmentId,
      contextId: req.authContext && req.authContext.contextId,
      name: admin.name
    });

    const { withTransaction } = require('../../../config/db');
    await withTransaction(async (conn) => {
      const subjects = designationTargets.map((targetAssignment) => ({
        personId: safeString(targetAssignment.person_id),
        legacyHrId: publicationAssignments.legacyHrIdOf(targetAssignment),
        organizationId: orgId,
        assignmentId: publicationAssignments.assignmentIdOf(targetAssignment)
      }));
      if (safeString(designatorSnapshot.personId)) {
        subjects.push({
          personId: safeString(designatorSnapshot.personId),
          organizationId: orgId,
          assignmentId: safeString(designatorSnapshot.assignmentId),
          requireMembership: Boolean(safeString(designatorSnapshot.assignmentId))
        });
      }
      await unifiedIdentityModel.lockActiveBusinessSubjects(conn, subjects);
      await assertDesignationTargetsAvailable(conn, orgId, pubId, clauseIds, designationTargets);
      // Delete all designations for ALL clauses in this identity group
      const delPh = clauseIds.map(() => '?').join(',');
      await conn.query(`DELETE FROM merit_list_designations WHERE clause_id IN (${delPh}) AND org_id = ?`, [...clauseIds, orgId]);
      // Insert all under the primary clause (dedup already done above)
      for (const targetAssignment of designationTargets) {
        const targetSnapshot = participantService.buildAssignmentSnapshot(targetAssignment);
        await conn.query(
          `INSERT INTO merit_list_designations
            (id, publication_id, clause_id, target_hr_id, target_assignment_id, target_context_snapshot,
             designated_by, designated_by_person_id, designated_by_assignment_id,
             designated_by_context_snapshot, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            generateId(), pubId, primaryClauseId,
            publicationAssignments.legacyHrIdOf(targetAssignment),
            publicationAssignments.assignmentIdOf(targetAssignment),
            JSON.stringify(targetSnapshot), admin.id,
            safeString(designatorSnapshot.personId) || null,
            safeString(designatorSnapshot.assignmentId) || null,
            JSON.stringify(designatorSnapshot), orgId
          ]
        );
      }
    });

    // Query only the designations for the clauses just edited (not entire publication)
    const clausesPh = clauseIds.map(() => '?').join(',');
    const [designations] = await pool.query(
      `SELECT * FROM merit_list_designations WHERE clause_id IN (${clausesPh}) AND org_id = ?`,
      [...clauseIds, orgId]
    );
    const presentations = buildDesignationPresentations(designations, await fetchOrgLookups());
    const result = presentations.map((item) => ({
      ...item,
      targetName: item.name,
      targetStudentId: item.studentId
    }));
    res.json({ status: 'success', designations: result, message: localeFormat(localeCopy.copy_02f1651e0a, [result.length]) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.json({ status: 'duplicate_hr', message: localeCopy.copy_6f354dd08e });
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ─── removeMeritListDesignation ───
router.post('/removeMeritListDesignation', (req, res) => {
  return rejectRetiredEndpoint(res);
});

// ─── getPublicResults (user-facing) ───
router.post('/getPublicResults', async (req, res) => {
  try {
    const activityId = safeString(req.body.activityId);
    if (!getAuthenticatedContext(req)) return res.json({ status: 'auth_failed', message: localeCopy.copy_c22a252e97 });
    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_21368b3e76 });

    const publication = await publicationModel.getByActivity(activityId);
    if (!publication || !publication.is_published) return res.json({ status: 'not_published', message: localeCopy.copy_c390fbf5b7 });

    const orgId = await getCurrentOrgId();
    const activity = await activityModel.getById(activityId);
    if (!activity) return res.json({ status: 'activity_not_found', message: localeCopy.copy_939db6a08b });
    const granularity = participantService.normalizeGranularity(activity.participant_granularity);
    const actorResult = await resolveCurrentActor(req);
    if (!actorResult.ok || actorResult.actor.type !== 'user') {
      return res.json({ status: actorResult.status || 'not_bound', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const [viewerRecord, participantRows, lookups, scoreRecords] = await Promise.all([
      participantService.resolveActorParticipant(orgId, actorResult.actor, granularity),
      participantService.listParticipants(orgId, granularity),
      fetchOrgLookups(),
      scoreRecordModel.getByActivity(activityId)
    ]);
    if (!viewerRecord) return res.json({ status: 'not_bound', message: localeCopy.copy_c20c4aad74 });
    const viewer = {
      id: safeString(viewerRecord.id),
      personId: safeString(viewerRecord.person_id),
      departmentId: safeString(viewerRecord.department_id),
      identityId: safeString(viewerRecord.identity_id),
      workGroupId: safeString(viewerRecord.work_group_id)
    };

    const [viewRuleRows] = await pool.query('SELECT * FROM pub_view_rules WHERE publication_id = ? AND org_id = ?', [publication.id, orgId]);
    const matchingRules = viewRuleRows.filter(r => safeString(r.grantee_department_id) === viewer.departmentId && safeString(r.grantee_identity_id) === viewer.identityId);
    if (!matchingRules.length) return res.json({ status: 'no_permission', message: localeCopy.copy_f4a11b6280 });

    // Collect all matching clauses (with per-clause display_mode)
    const matchingRuleIds = matchingRules.map((rule) => rule.id);
    const matchingRulePlaceholders = matchingRuleIds.map(() => '?').join(',');
    const [matchingClauses] = await pool.query(
      `SELECT * FROM pub_view_rule_clauses
        WHERE rule_id IN (${matchingRulePlaceholders}) AND org_id = ?
        ORDER BY rule_id, sort_order ASC`,
      [...matchingRuleIds, orgId]
    );
    if (!matchingClauses.length) return res.json({ status: 'no_permission', message: localeCopy.copy_f4a11b6280 });

    // Load per-clause grade bands in one batch
    const gradeBandsByClause = new Map();
    {
      const clauseIds = matchingClauses.map(c => c.id);
      if (clauseIds.length > 0) {
        const ph = clauseIds.map(() => '?').join(',');
        try {
          const [allGradeBands] = await pool.query(
            `SELECT * FROM pub_grade_bands WHERE clause_id IN (${ph}) AND org_id = ? ORDER BY clause_id, sort_order ASC`,
            [...clauseIds, orgId]
          );
          allGradeBands.forEach(gb => {
            if (!gradeBandsByClause.has(gb.clause_id)) gradeBandsByClause.set(gb.clause_id, []);
            gradeBandsByClause.get(gb.clause_id).push({
              minScore: Number(gb.min_score), maxScore: Number(gb.max_score),
              gradeName: safeString(gb.grade_name)
            });
          });
        } catch (e) {
          logger.warn('Failed to load grade bands in getPublicResults', { error: e.message });
        }
      }
    }

    const normalizedMembers = participantRows.map(m => ({
      id: safeString(m.id), assignmentId: safeString(m.assignment_id || m.id),
      assignmentKind: safeString(m.assignment_kind), name: safeString(m.name), studentId: safeString(m.student_id),
      personId: safeString(m.person_id),
      departmentId: safeString(m.department_id), identityId: safeString(m.identity_id), workGroupId: safeString(m.work_group_id),
      department: lookups.departmentsById.get(safeString(m.department_id)) || '',
      identity: lookups.identitiesById.get(safeString(m.identity_id)) || '',
      workGroup: lookups.workGroupsById.get(safeString(m.work_group_id)) || ''
    }));
    const membersByAssignmentId = new Map(normalizedMembers.map((member) => [member.assignmentId, member]));
    scoreRecords.forEach((record) => {
      const historical = participantService.resolveHistoricalParticipant(record, 'target', []);
      if (!historical.assignmentId || historical.historicalAssignmentUnavailable) return;
      membersByAssignmentId.set(historical.assignmentId, {
        id: historical.assignmentId,
        assignmentId: historical.assignmentId,
        assignmentKind: historical.assignmentNature,
        name: historical.name,
        studentId: historical.studentId,
        personId: historical.personId,
        departmentId: historical.departmentId,
        identityId: historical.identityCategoryId,
        workGroupId: historical.workGroupId,
        department: historical.department,
        identity: historical.identityCategory,
        workGroup: historical.workGroup,
        assignmentLabel: historical.assignmentLabel,
        historicalOnly: !normalizedMembers.some((member) => member.assignmentId === historical.assignmentId)
      });
    });
    const memberPresentation = participantService.decorateAssignmentDisambiguation(Array.from(membersByAssignmentId.values()));
    const allMembers = memberPresentation.rows;

    function matchScope(target, clause) {
      const st = safeString(clause.scope_type);
      if (st === 'own_results') return target.id === viewer.id;
      if (st === 'same_department_identity') return target.departmentId === viewer.departmentId && target.identityId === safeString(clause.target_identity_id);
      if (st === 'same_department_all') return target.departmentId === viewer.departmentId;
      if (st === 'same_work_group_identity') return target.departmentId === viewer.departmentId && target.workGroupId === viewer.workGroupId && target.identityId === safeString(clause.target_identity_id);
      if (st === 'same_work_group_all') return target.departmentId === viewer.departmentId && target.workGroupId === viewer.workGroupId;
      if (st === 'all_people') return true;
      return false;
    }

    // Build clause → target mapping (each target can appear in multiple clauses)
    const clauseTargetMap = new Map(); // clauseId → Set of target IDs
    const allVisibleIds = new Set();
    for (const clause of matchingClauses) {
      const targetSet = new Set();
      for (const m of allMembers) {
        if (matchScope(m, clause)) { targetSet.add(m.id); allVisibleIds.add(m.id); }
      }
      clauseTargetMap.set(clause.id, targetSet);
    }

    // ── Score computation with shared pubCache ──
    // Full three-layer score map is deterministic for a given (activity, org).
    // Cache hit → O(visibleTargetCount) pure Map lookups, zero DB.
    // Cache auto-expires after 5 min; invalidated on score submission.
    let cached = await pubCache.get(activityId, orgId);
    if (!cached || !cached.diagnostics) {
      if (cached) await pubCache.invalidate(activityId, orgId);
      const { computeValidScoreMap } = require('../utils/scoreCalc');
      cached = await computeValidScoreMap(activityId, orgId, {});
    }
    const { getHistoricalSnapshotFailure } = require('../utils/scoreCalc');
    const historicalFailure = getHistoricalSnapshotFailure(cached.diagnostics);
    if (historicalFailure) {
      return res.json(Object.assign({}, historicalFailure, {
        message: historicalFailure.status === 'historical_snapshot_missing'
          ? localeCopy.historicalSnapshotMissing
          : localeCopy.historicalSnapshotInvalid
      }));
    }
    await pubCache.set(activityId, orgId, cached);
    const fullScoreMap = (cached instanceof Map) ? cached : (cached && cached.finalScoreMap instanceof Map ? cached.finalScoreMap : new Map());

    // Filter cached full map to visible targets only (pure O(1) Map.get, no side effects)
    const scoreMap = new Map();
    for (const tid of allVisibleIds) {
      const sd = fullScoreMap.get(tid);
      if (sd) scoreMap.set(tid, sd);
    }

    // Debug: log viewer score stats (non-sensitive aggregate only)
    logger.debug('getPublicResults viewer stats', {
      viewerId: (viewer.id || '').slice(0, 8),
      visibleTargetCount: allVisibleIds.size
    });

    // Build scope label lookup
    const scopeLabelMap = {
      own_results: scoringCopy.scopeShortOwnResults,
      same_department_identity: scoringCopy.scopeShortSameDepartment,
      same_department_all: scoringCopy.scopeShortSameDepartmentAll,
      same_work_group_identity: scoringCopy.scopeShortSameWorkGroup,
      same_work_group_all: scoringCopy.scopeShortSameWorkGroupAll,
      all_people: scoringCopy.scopeShortAllPeople
    };

    // Build per-clause groups
    const groups = [];
    const seenMemberInClause = new Map(); // memberId → Set of clauseIds (for dedup across clauses)
    const memberCache = new Map(); // memberId → enriched member data

    for (const clause of matchingClauses) {
      const targetIds = clauseTargetMap.get(clause.id) || new Set();
      if (!targetIds.size) continue;

      const clauseDisplayMode = safeString(clause.display_mode) || 'score';
      const clauseGradeBands = gradeBandsByClause.get(clause.id) || [];
      const targetIdentityName = lookups.identitiesById.get(safeString(clause.target_identity_id)) || '';

      // Build group label
      let groupLabel = scopeLabelMap[safeString(clause.scope_type)] || safeString(clause.scope_type);
      if (targetIdentityName) groupLabel = groupLabel + ' ' + targetIdentityName;
      if (clauseDisplayMode === 'grade') groupLabel = groupLabel + localeCopy.copy_880ad7309d;

      const members = [];
      for (const targetId of targetIds) {
        const member = allMembers.find(m => m.id === targetId);
        if (!member) continue;
        const scoreData = scoreMap.get(member.id);
        const rawScore = (scoreData && typeof scoreData.finalScore === 'number') ? scoreData.finalScore : 0;

        const entry = {
          assignmentId: member.assignmentId,
          personId: member.personId,
          name: member.name,
          department: safeString(member.department) || lookups.departmentsById.get(member.departmentId) || safeString(member.departmentId) || localeCopy.copy_25e27df7c6,
          identity: safeString(member.identity) || lookups.identitiesById.get(member.identityId) || safeString(member.identityId) || localeCopy.copy_25e27df7c6,
          workGroup: safeString(member.workGroup) || lookups.workGroupsById.get(member.workGroupId) || safeString(member.workGroupId) || localeCopy.copy_25e27df7c6,
          sortScore: rawScore,
          finalScore: Number(rawScore).toFixed(3)
        };
        if (member.needsAssignmentDisambiguation) {
          entry.needsAssignmentDisambiguation = true;
          entry.assignmentLabel = member.assignmentLabel;
        }

        // Always map grade when in grade mode (fallback to '未评级' if no bands or no match)
        if (clauseDisplayMode === 'grade') {
          entry.grade = applyGradeBands(rawScore, clauseGradeBands);
        }

        members.push(entry);
      }

      // Debug: log first group's aggregate stats (no individual scores)
      if (members.length > 0) {
        logger.debug('getPublicResults clause summary', {
          clauseId: clause.id,
          scopeType: safeString(clause.scope_type),
          displayMode: clauseDisplayMode,
          bandCount: clauseGradeBands.length,
          memberCount: members.length
        });
      }

      // Sort members by score descending
      members.sort((a, b) => (b.sortScore || 0) - (a.sortScore || 0));

      groups.push({
        clauseId: clause.id,
        displayMode: clauseDisplayMode,
        groupLabel,
        memberCount: members.length,
        members
      });
    }

    res.json({
      status: 'success',
      needsAssignmentDisambiguation: memberPresentation.needsAssignmentDisambiguation,
      groups
    });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── getPublicMeritList (user-facing) ───
router.post('/getPublicMeritList', async (req, res) => {
  try {
    const activityId = safeString(req.body.activityId);
    if (!getAuthenticatedContext(req)) return res.json({ status: 'auth_failed', message: localeCopy.copy_c22a252e97 });
    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_21368b3e76 });

    const publication = await publicationModel.getByActivity(activityId);
    if (!publication || !publication.is_published) return res.json({ status: 'not_published', message: localeCopy.copy_c390fbf5b7 });

    // 当前评优权限只认请求中明确选择的活动岗位，不得从 hr_info 猜测岗位。
    let canDesignate = false;
    let matchingRules = [];
    let matchingMeritClauses = [];
    const orgId = await getCurrentOrgId();
    const actorResult = await resolveCurrentActor(req);
    if (!actorResult.ok || actorResult.actor.type !== 'user') {
      return res.json({ status: actorResult.status || 'work_context_required', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const activeAssignments = await participantService.listParticipants(orgId, 'assignment');
    const viewerAssignment = activeAssignments.find((assignment) => (
      publicationAssignments.assignmentIdOf(assignment) === safeString(actorResult.actor.assignmentId)
      && (!safeString(actorResult.actor.personId) || safeString(assignment.person_id) === safeString(actorResult.actor.personId))
      && (!safeString(actorResult.actor.membershipId) || safeString(assignment.membership_id) === safeString(actorResult.actor.membershipId))
    ));
    if (!viewerAssignment) {
      return res.json({ status: 'work_context_required', message: localeCopy.copy_c20c4aad74 });
    }
    const [meritRuleRows] = await pool.query('SELECT * FROM pub_merit_rules WHERE publication_id = ? AND org_id = ?', [publication.id, orgId]);
    matchingRules = meritRuleRows.filter((rule) => publicationAssignments.matchesRuleGrantee(viewerAssignment, rule));
    if (matchingRules.length > 0) {
      const ruleIds = matchingRules.map(r => r.id);
      const ph = ruleIds.map(() => '?').join(',');
      [matchingMeritClauses] = await pool.query(
        `SELECT * FROM pub_merit_rule_clauses
          WHERE rule_id IN (${ph}) AND org_id = ?
          ORDER BY rule_id, sort_order`,
        [...ruleIds, orgId]
      );
      canDesignate = matchingMeritClauses.length > 0;
    }

    const designations = await designationModel.getByPublication(publication.id);
    // Only include designations linked to clauses under the viewer's OWN matching rules.
    // Build clause set from matchingRules only (not ALL publication rules).
    const viewerClauseIds = new Set();
    matchingMeritClauses.forEach((clause) => viewerClauseIds.add(clause.id));
    const lookups = await fetchOrgLookups();
    const result = [];
    const visibleDesignations = designations.filter((item) => (
      item.clause_id && viewerClauseIds.has(item.clause_id)
    ));
    const designationPresentations = buildDesignationPresentations(visibleDesignations, lookups);
    for (let index = 0; index < visibleDesignations.length; index += 1) {
      const d = visibleDesignations[index];
      const cid = d.clause_id || '';
      // Only show designations that belong to the viewer's own merit rule clauses
      if (!cid || !viewerClauseIds.has(cid)) continue;
      const presentation = designationPresentations[index];
      result.push({
        id: d.id,
        targetHrId: presentation.targetHrId,
        targetAssignmentId: presentation.targetAssignmentId,
        assignmentId: presentation.targetAssignmentId,
        personId: presentation.personId,
        name: presentation.name,
        studentId: presentation.studentId,
        department: presentation.department,
        departmentId: presentation.departmentId,
        identity: presentation.identity,
        identityId: presentation.identityId,
        identityCategoryId: presentation.identityCategoryId,
        workGroup: presentation.workGroup,
        assignmentNature: presentation.assignmentNature,
        assignmentLabel: presentation.assignmentLabel,
        historicalAssignmentUnavailable: presentation.historicalAssignmentUnavailable
      });
    }
    // Collect user's own merit clauses for the designation picker
    const userClauses = [];
    // Build scoped designation candidates (so frontend does NOT need admin-only listHrInfo)
    let designationCandidates = [];
    let needsAssignmentDisambiguation = false;
    if (canDesignate) {
      // 新记录按岗位 ID 回显；旧 HR 记录仅在唯一岗位可解析时进入该集合。
      const designatedIdSet = new Set(result.map(d => d.targetAssignmentId).filter(Boolean));

      const clausesByRule = new Map();
      matchingMeritClauses.forEach((clause) => {
        if (!clausesByRule.has(clause.rule_id)) clausesByRule.set(clause.rule_id, []);
        clausesByRule.get(clause.rule_id).push(clause);
      });
      for (const rule of matchingRules) {
        const clauses = clausesByRule.get(rule.id) || [];
        for (const c of clauses) {
          const targetIdentityName = lookups.identitiesById.get(safeString(c.target_identity_id)) || '';
          userClauses.push({
            id: c.id, ruleId: rule.id,
            scopeType: c.scope_type,
            targetIdentityId: c.target_identity_id,
            targetIdentity: targetIdentityName,
            quotaLimit: c.quota_limit || 0,
            requireExactQuota: (c.require_exact_quota === 1),
            granteeDepartmentId: safeString(rule.grantee_department_id),
            granteeIdentityId: safeString(rule.grantee_identity_id)
          });

        }
      }
      const candidatePresentation = publicationAssignments.buildDesignationCandidates(
        activeAssignments,
        matchingMeritClauses,
        viewerAssignment,
        lookups,
        designatedIdSet
      );
      designationCandidates = candidatePresentation.rows;
      needsAssignmentDisambiguation = candidatePresentation.needsAssignmentDisambiguation;
    }
    res.json({
      status: 'success',
      meritList: result,
      canDesignate,
      canViewMeritList: canDesignate,
      clauses: userClauses,
      designationCandidates,
      needsAssignmentDisambiguation,
      publicationId: publication.id
    });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── submitMeritListDesignations (user-facing, grantee-verified) ───
router.post('/submitMeritListDesignations', async (req, res) => {
  try {
    const publicationId = safeString(req.body.publicationId);
    const clauseIds = Array.isArray(req.body.clauseIds) && req.body.clauseIds.length
      ? req.body.clauseIds.map(id => safeString(id)).filter(Boolean)
      : [safeString(req.body.clauseId) || safeString(req.body.permissionId)];
    const primaryClauseId = clauseIds[0];
    const designationTargetIds = getDesignationTargetIds(req.body);

    if (!getAuthenticatedContext(req)) return res.json({ status: 'auth_failed', message: localeCopy.copy_c22a252e97 });
    if (!primaryClauseId || !publicationId) return res.json({ status: 'invalid_params', message: localeCopy.copy_157f5cd8f8 });

    // Look up clause + parent merit rule (include publication_id for reliable lookup)
    const orgId = await getCurrentOrgId();
    const actorResult = await resolveCurrentActor(req);
    if (!actorResult.ok || actorResult.actor.type !== 'user') {
      return res.json({ status: actorResult.status || 'work_context_required', message: actorResult.message || localeCopy.copy_4e84385ce1 });
    }
    const activeAssignments = await participantService.listParticipants(orgId, 'assignment');
    const viewerAssignment = activeAssignments.find((assignment) => (
      publicationAssignments.assignmentIdOf(assignment) === safeString(actorResult.actor.assignmentId)
      && (!safeString(actorResult.actor.personId) || safeString(assignment.person_id) === safeString(actorResult.actor.personId))
      && (!safeString(actorResult.actor.membershipId) || safeString(assignment.membership_id) === safeString(actorResult.actor.membershipId))
    ));
    if (!viewerAssignment) {
      return res.json({ status: 'work_context_required', message: localeCopy.copy_c20c4aad74 });
    }
    const [[clause]] = await pool.query(
      `SELECT pmrc.*, pmr.grantee_department_id, pmr.grantee_identity_id, pmr.publication_id
         FROM pub_merit_rule_clauses pmrc
         JOIN pub_merit_rules pmr ON pmr.id = pmrc.rule_id
        WHERE pmrc.id = ? AND pmrc.org_id = ? AND pmr.org_id = ? AND pmr.publication_id = ?`,
      [primaryClauseId, orgId, orgId, publicationId]
    );
    if (!clause) return res.json({ status: 'not_found', message: localeCopy.copy_22d72751cb });
    if (!publicationAssignments.matchesRuleGrantee(viewerAssignment, clause))
      return res.json({ status: 'forbidden', message: localeCopy.copy_cfa6e136e4 });

    // Use merit rule's publication_id (reliable), fall back to frontend-supplied
    const pubId = safeString(clause.publication_id) || publicationId;
    const publication = await publicationModel.getById(pubId);
    if (!publication || !publication.is_published) return res.json({ status: 'not_published', message: localeCopy.copy_c390fbf5b7 });

    // Aggregate quota across all clauses in a single query
    let aggregatedQuotaLimit = 0, hasExactQuota = false;
    let selectedClauses = [];
    if (clauseIds.length > 1) {
      const placeholders = clauseIds.map(() => '?').join(',');
      const [quotaRows] = await pool.query(
        `SELECT id, scope_type, target_identity_id, quota_limit, require_exact_quota
           FROM pub_merit_rule_clauses
          WHERE id IN (${placeholders}) AND rule_id = ? AND org_id = ?`,
        [...clauseIds, clause.rule_id, orgId]
      );
      if (quotaRows.length !== clauseIds.length) {
        return res.json({ status: 'invalid_params', message: localeCopy.copy_7bd7eb5da6 });
      }
      for (const cl of quotaRows) {
        aggregatedQuotaLimit = Math.max(aggregatedQuotaLimit, cl.quota_limit || 0);
        if (cl.require_exact_quota) hasExactQuota = true;
      }
      const clauseOrder = new Map(clauseIds.map((id, index) => [id, index]));
      selectedClauses = quotaRows.slice().sort((left, right) => (
        clauseOrder.get(left.id) - clauseOrder.get(right.id)
      ));
    } else {
      aggregatedQuotaLimit = clause.quota_limit || 0;
      hasExactQuota = !!(clause.require_exact_quota);
      selectedClauses = [clause];
    }
    const targetValidation = publicationAssignments.validateDesignationTargets(
      designationTargetIds,
      activeAssignments,
      selectedClauses,
      viewerAssignment
    );
    if (!targetValidation.ok) {
      if (targetValidation.status === 'invalid_assignment' || targetValidation.status === 'ambiguous_assignment') {
        return res.json({ status: 'invalid_hr', reason: targetValidation.status, message: localeCopy.copy_f3dd2d1ffc });
      }
      return res.json({
        status: 'out_of_scope',
        message: localeFormat(localeCopy.copy_45ccfd7d80, [targetValidation.targetId])
      });
    }
    const designationTargets = targetValidation.targets;
    if (hasExactQuota && aggregatedQuotaLimit > 0 && designationTargets.length !== aggregatedQuotaLimit)
      return res.json({ status: 'quota_mismatch', message: localeFormat(localeCopy.copy_b947327844, [aggregatedQuotaLimit]) });
    if (!hasExactQuota && aggregatedQuotaLimit > 0 && designationTargets.length > aggregatedQuotaLimit)
      return res.json({ status: 'quota_exceeded', message: localeFormat(localeCopy.copy_7010de3cee, [aggregatedQuotaLimit]) });

    const designatorSnapshot = buildDesignatorSnapshot(req, actorResult.actor, viewerAssignment);

    const { withTransaction } = require('../../../config/db');
    await withTransaction(async (conn) => {
      await unifiedIdentityModel.lockActiveBusinessSubjects(conn, [viewerAssignment]
        .concat(designationTargets)
        .map((assignment) => ({
          personId: safeString(assignment.person_id),
          legacyHrId: publicationAssignments.legacyHrIdOf(assignment),
          organizationId: orgId,
          assignmentId: publicationAssignments.assignmentIdOf(assignment)
        })));
      await assertDesignationTargetsAvailable(conn, orgId, pubId, clauseIds, designationTargets);
      // Delete all designations for ALL clauses in this identity group
      const delPh = clauseIds.map(() => '?').join(',');
      await conn.query(`DELETE FROM merit_list_designations WHERE clause_id IN (${delPh}) AND org_id = ?`, [...clauseIds, orgId]);
      // 每个岗位写入其实际匹配的条款；同一岗位匹配多条时按前端条款顺序稳定选择。
      for (const targetAssignment of designationTargets) {
        const matchedClause = selectedClauses.find((selectedClause) => (
          publicationAssignments.matchesMeritClause(targetAssignment, selectedClause, viewerAssignment)
        ));
        if (!matchedClause) throw new Error(localeCopy.copy_45ccfd7d80);
        const targetSnapshot = participantService.buildAssignmentSnapshot(targetAssignment);
        await conn.query(
          `INSERT INTO merit_list_designations
            (id, publication_id, clause_id, target_hr_id, target_assignment_id, target_context_snapshot,
             designated_by, designated_by_person_id, designated_by_assignment_id,
             designated_by_context_snapshot, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            generateId(), pubId, matchedClause.id,
            publicationAssignments.legacyHrIdOf(targetAssignment),
            publicationAssignments.assignmentIdOf(targetAssignment),
            JSON.stringify(targetSnapshot), '',
            safeString(actorResult.actor.personId) || null,
            safeString(actorResult.actor.assignmentId) || null,
            JSON.stringify(designatorSnapshot), orgId
          ]
        );
      }
    });

    const savedClausePlaceholders = clauseIds.map(() => '?').join(',');
    const [designations] = await pool.query(
      `SELECT * FROM merit_list_designations WHERE clause_id IN (${savedClausePlaceholders}) AND org_id = ?`,
      [...clauseIds, orgId]
    );
    const presentations = buildDesignationPresentations(designations, await fetchOrgLookups());
    const result = presentations.map((item) => ({
      ...item,
      clauseId: item.clauseId,
      targetName: item.name,
      targetStudentId: item.studentId
    }));
    res.json({ status: 'success', designations: result, message: localeFormat(localeCopy.copy_02f1651e0a, [result.length]) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.json({ status: 'duplicate_hr', message: localeCopy.copy_6f354dd08e });
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// ─── generatePubViewRules ───
router.post('/generatePubViewRules', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const publicationId = safeString(req.body.publicationId);
    if (!publicationId) return res.json({ status: 'invalid_params', message: localeCopy.copy_db10aa8501 });

    const orgId = await getCurrentOrgId();
    const [[pubCheck]] = await pool.query('SELECT id FROM result_publications WHERE id = ? AND org_id = ?', [publicationId, orgId]);
    if (!pubCheck) return res.json({ status: 'invalid_params', message: localeCopy.copy_c2ca4efbfa });

    // 自动规则只从当前在职成员的活动岗位生成，禁止读取 hr_info 兼容快照。
    const activeAssignments = await participantService.listParticipants(orgId, 'assignment');
    // Get existing view rules
    const [existingRules] = await pool.query('SELECT grantee_department_id, grantee_identity_id FROM pub_view_rules WHERE publication_id = ? AND org_id = ?', [publicationId, orgId]);

    const existingKeys = new Set();
    existingRules.forEach(r => existingKeys.add(safeString(r.grantee_department_id) + '::' + safeString(r.grantee_identity_id)));

    const categories = publicationAssignments.collectRuleCategories(activeAssignments);

    const now = nowMysqlUtc();
    let createdCount = 0;
    for (const [key, cat] of categories) {
      if (existingKeys.has(key)) continue;
      const ruleId = generateId();
      await pool.query(
        'INSERT INTO pub_view_rules (id, publication_id, grantee_department_id, grantee_identity_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ruleId, publicationId, cat.deptId, cat.identId, orgId, now, now]
      );
      // No default clause — user configures rules manually
      createdCount++;
    }

    const backfilledCount = 0; // No longer auto-creating clauses

    res.json({ status: 'success', totalCategories: categories.size, createdCount, skippedCount: categories.size - createdCount, backfilledCount });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── generatePubMeritRules ───
router.post('/generatePubMeritRules', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const publicationId = safeString(req.body.publicationId);
    if (!publicationId) return res.json({ status: 'invalid_params', message: localeCopy.copy_db10aa8501 });

    const orgId = await getCurrentOrgId();
    const [[pubCheck]] = await pool.query('SELECT id FROM result_publications WHERE id = ? AND org_id = ?', [publicationId, orgId]);
    if (!pubCheck) return res.json({ status: 'invalid_params', message: localeCopy.copy_c2ca4efbfa });

    // Get existing view rules as source
    const [viewRules] = await pool.query('SELECT grantee_department_id, grantee_identity_id FROM pub_view_rules WHERE publication_id = ? AND org_id = ?', [publicationId, orgId]);
    // Get existing merit rules
    const [existingMeritRules] = await pool.query('SELECT grantee_department_id, grantee_identity_id FROM pub_merit_rules WHERE publication_id = ? AND org_id = ?', [publicationId, orgId]);

    const existingKeys = new Set();
    existingMeritRules.forEach(r => existingKeys.add(safeString(r.grantee_department_id) + '::' + safeString(r.grantee_identity_id)));

    const now = nowMysqlUtc();
    let createdCount = 0;
    for (const rule of viewRules) {
      const key = safeString(rule.grantee_department_id) + '::' + safeString(rule.grantee_identity_id);
      if (existingKeys.has(key)) continue;
      const meritRuleId = generateId();
      await pool.query(
        'INSERT INTO pub_merit_rules (id, publication_id, grantee_department_id, grantee_identity_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [meritRuleId, publicationId, rule.grantee_department_id, rule.grantee_identity_id, orgId, now, now]
      );
      // No default clause — user configures rules manually
      createdCount++;
    }

    const backfilledCount = 0; // No longer auto-creating clauses

    res.json({ status: 'success', totalViewCategories: viewRules.length, createdCount, skippedCount: viewRules.length - createdCount, backfilledCount });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── savePubViewRule ───
router.post('/savePubViewRule', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const orgId = await getCurrentOrgId();
    const ruleId = await withTransaction(async (connection) => {
      const input = await normalizePubViewRuleInput(connection, orgId, req.body);
      return savePubViewRuleWithConnection(connection, orgId, input);
    });
    res.json({ status: 'success', id: ruleId });
  } catch (e) { respondPublicationRuleError(res, e); }
});

// ─── batchSavePubViewRules ───
router.post('/batchSavePubViewRules', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const rules = getPublicationRuleBatch(req.body);
    const orgId = await getCurrentOrgId();
    const ids = await withTransaction(async (connection) => {
      const inputs = [];
      for (const rule of rules) inputs.push(await normalizePubViewRuleInput(connection, orgId, rule));
      assertUniquePublicationRuleBatch(inputs);
      const savedIds = [];
      for (const input of inputs) savedIds.push(await savePubViewRuleWithConnection(connection, orgId, input));
      return savedIds;
    });
    res.json({ status: 'success', count: ids.length, ids });
  } catch (e) { respondPublicationRuleError(res, e, scoringCopy.batchOperationFailed); }
});

// ─── listPubViewRules ───
router.post('/listPubViewRules', async (req, res) => {
  return rejectRetiredEndpoint(res);
  /* istanbul ignore next -- 仅保留一轮源代码兼容上下文，后续版本物理删除。 */
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const publicationId = safeString(req.body.publicationId);
    if (!publicationId) return res.json({ status: 'invalid_params', message: localeCopy.copy_db10aa8501 });
    const orgId = await getCurrentOrgId();
    const [rules] = await pool.query('SELECT * FROM pub_view_rules WHERE publication_id=? AND org_id=?', [publicationId, orgId]);

    const ruleIds = rules.map((rule) => rule.id);
    let allClauses = [];
    if (ruleIds.length) {
      const placeholders = ruleIds.map(() => '?').join(',');
      [allClauses] = await pool.query(
        `SELECT * FROM pub_view_rule_clauses
          WHERE rule_id IN (${placeholders}) AND org_id = ?
          ORDER BY rule_id, sort_order`,
        [...ruleIds, orgId]
      );
    }

    // Load grade bands for all clauses in one batch (per-clause level)
    const gradeBandsByClause = new Map();
    if (allClauses.length > 0) {
      const clauseIds = allClauses.map(c => c.id);
      const ph = clauseIds.map(() => '?').join(',');
      try {
        const [allGradeBands] = await pool.query(
          `SELECT * FROM pub_grade_bands WHERE clause_id IN (${ph}) AND org_id = ? ORDER BY clause_id, sort_order ASC`,
          [...clauseIds, orgId]
        );
        allGradeBands.forEach(gb => {
          if (!gradeBandsByClause.has(gb.clause_id)) gradeBandsByClause.set(gb.clause_id, []);
          gradeBandsByClause.get(gb.clause_id).push({
            id: gb.id, clauseId: gb.clause_id,
            minScore: Number(gb.min_score), maxScore: Number(gb.max_score),
            gradeName: safeString(gb.grade_name), sortOrder: gb.sort_order
          });
        });
      } catch (e) {
        // Table may not exist yet — grade bands will be empty
      }
    }

    // Build clause map by rule_id
    const clausesByRule = new Map();
    for (const c of allClauses) {
      if (!clausesByRule.has(c.rule_id)) clausesByRule.set(c.rule_id, []);
      clausesByRule.get(c.rule_id).push(c);
    }

    const lookups = await fetchOrgLookups();
    const result = [];
    for (const r of rules) {
      const clauses = (clausesByRule.get(r.id) || []).map(c => ({
        id: c.id, scopeType: c.scope_type, targetIdentityId: c.target_identity_id || '',
        targetIdentity: lookups.identitiesById.get(safeString(c.target_identity_id || '')) || '',
        displayMode: safeString(c.display_mode) || 'score',
        gradeBands: gradeBandsByClause.get(c.id) || [],
        sortOrder: c.sort_order
      }));
      result.push({
        id: r.id, publicationId: r.publication_id,
        granteeDepartmentId: r.grantee_department_id, granteeDepartment: lookups.departmentsById.get(safeString(r.grantee_department_id)) || '',
        granteeIdentityId: r.grantee_identity_id, granteeIdentity: lookups.identitiesById.get(safeString(r.grantee_identity_id)) || '',
        clauseCount: clauses.length, clauses
      });
    }
    res.json({ status: 'success', rules: result });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── deletePubViewRule ───
router.post('/deletePubViewRule', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const ruleId = safeString(req.body.ruleId);
    if (!ruleId) return res.json({ status: 'invalid_params', message: localeCopy.copy_6c0be05046 });
    const orgId = await getCurrentOrgId();
    await withTransaction((connection) => deletePubViewRuleWithConnection(connection, orgId, ruleId));
    res.json({ status: 'success', message: localeCopy.copy_5398fec054 });
  } catch (e) { respondPublicationRuleError(res, e); }
});

// ─── batchDeletePubViewRules ───
router.post('/batchDeletePubViewRules', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const ruleIds = getPublicationRuleIdBatch(req.body);
    const orgId = await getCurrentOrgId();
    const deletedIds = await withTransaction(async (connection) => {
      const result = [];
      for (const ruleId of ruleIds) {
        if (await deletePubViewRuleWithConnection(connection, orgId, ruleId, { requireExisting: true })) result.push(ruleId);
      }
      return result;
    });
    res.json({ status: 'success', count: deletedIds.length, ids: deletedIds });
  } catch (e) { respondPublicationRuleError(res, e, scoringCopy.batchOperationFailed); }
});

// ─── savePubMeritRule ───
router.post('/savePubMeritRule', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const orgId = await getCurrentOrgId();
    const ruleId = await withTransaction(async (connection) => {
      const input = await normalizePubMeritRuleInput(connection, orgId, req.body);
      return savePubMeritRuleWithConnection(connection, orgId, input);
    });
    res.json({ status: 'success', id: ruleId });
  } catch (e) { respondPublicationRuleError(res, e); }
});

// ─── batchSavePubMeritRules ───
router.post('/batchSavePubMeritRules', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const rules = getPublicationRuleBatch(req.body);
    const orgId = await getCurrentOrgId();
    const ids = await withTransaction(async (connection) => {
      const inputs = [];
      for (const rule of rules) inputs.push(await normalizePubMeritRuleInput(connection, orgId, rule));
      assertUniquePublicationRuleBatch(inputs);
      const savedIds = [];
      for (const input of inputs) savedIds.push(await savePubMeritRuleWithConnection(connection, orgId, input));
      return savedIds;
    });
    res.json({ status: 'success', count: ids.length, ids });
  } catch (e) { respondPublicationRuleError(res, e, scoringCopy.batchOperationFailed); }
});

// ─── listPubMeritRules ───
router.post('/listPubMeritRules', async (req, res) => {
  return rejectRetiredEndpoint(res);
  /* istanbul ignore next -- 仅保留一轮源代码兼容上下文，后续版本物理删除。 */
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const publicationId = safeString(req.body.publicationId);
    if (!publicationId) return res.json({ status: 'invalid_params', message: localeCopy.copy_db10aa8501 });
    const orgId = await getCurrentOrgId();
    const [rules] = await pool.query('SELECT * FROM pub_merit_rules WHERE publication_id=? AND org_id=?', [publicationId, orgId]);
    const lookups = await fetchOrgLookups();
    const ruleIds = rules.map((rule) => rule.id);
    let allClauses = [];
    if (ruleIds.length) {
      const placeholders = ruleIds.map(() => '?').join(',');
      [allClauses] = await pool.query(
        `SELECT * FROM pub_merit_rule_clauses
          WHERE rule_id IN (${placeholders}) AND org_id = ?
          ORDER BY rule_id, sort_order`,
        [...ruleIds, orgId]
      );
    }
    const clausesByRule = new Map();
    allClauses.forEach((clause) => {
      if (!clausesByRule.has(clause.rule_id)) clausesByRule.set(clause.rule_id, []);
      clausesByRule.get(clause.rule_id).push(clause);
    });
    const result = [];
    for (const r of rules) {
      const clauses = clausesByRule.get(r.id) || [];
      result.push({
        id: r.id, publicationId: r.publication_id,
        granteeDepartmentId: r.grantee_department_id, granteeDepartment: lookups.departmentsById.get(safeString(r.grantee_department_id)) || '',
        granteeIdentityId: r.grantee_identity_id, granteeIdentity: lookups.identitiesById.get(safeString(r.grantee_identity_id)) || '',
        clauseCount: clauses.length,
        clauses: clauses.map(c => ({ id: c.id, scopeType: c.scope_type, targetIdentityId: c.target_identity_id || '', targetIdentity: lookups.identitiesById.get(safeString(c.target_identity_id || '')) || '', quotaLimit: c.quota_limit || 0, requireExactQuota: (c.require_exact_quota === 1), sortOrder: c.sort_order }))
      });
    }
    res.json({ status: 'success', rules: result });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── deletePubMeritRule ───
router.post('/deletePubMeritRule', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const ruleId = safeString(req.body.ruleId);
    if (!ruleId) return res.json({ status: 'invalid_params', message: localeCopy.copy_6c0be05046 });
    const orgId = await getCurrentOrgId();
    await withTransaction((connection) => deletePubMeritRuleWithConnection(connection, orgId, ruleId));
    res.json({ status: 'success', message: localeCopy.copy_5398fec054 });
  } catch (e) { respondPublicationRuleError(res, e); }
});

// ─── batchDeletePubMeritRules ───
router.post('/batchDeletePubMeritRules', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const ruleIds = getPublicationRuleIdBatch(req.body);
    const orgId = await getCurrentOrgId();
    const deletedIds = await withTransaction(async (connection) => {
      const result = [];
      for (const ruleId of ruleIds) {
        if (await deletePubMeritRuleWithConnection(connection, orgId, ruleId, { requireExisting: true })) result.push(ruleId);
      }
      return result;
    });
    res.json({ status: 'success', count: deletedIds.length, ids: deletedIds });
  } catch (e) { respondPublicationRuleError(res, e, scoringCopy.batchOperationFailed); }
});

// ─── getMeritListSummary (admin) ───
router.post('/getMeritListSummary', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const activityId = safeString(req.body.activityId);
    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_21368b3e76 });

    const orgId = await getCurrentOrgId();
    const publication = await publicationModel.getByActivity(activityId);
    if (!publication) return res.json({ status: 'not_found', message: localeCopy.copy_c2ca4efbfa });

    const lookups = await fetchOrgLookups();

    // Get all merit rules with clauses and designations — batch all queries
    const [meritRules] = await pool.query('SELECT * FROM pub_merit_rules WHERE publication_id = ? AND org_id = ?', [publication.id, orgId]);
    if (!meritRules.length) {
      return res.json({ status: 'success', groups: [], departmentOptions: [], identityOptions: [], workGroupOptions: [] });
    }

    // Batch-load all clauses
    const ruleIds = meritRules.map(r => r.id);
    const rulePh = ruleIds.map(() => '?').join(',');
    const [allClauses] = await pool.query(
      `SELECT * FROM pub_merit_rule_clauses WHERE rule_id IN (${rulePh}) AND org_id = ? ORDER BY sort_order`,
      [...ruleIds, orgId]
    );
    const clausesByRule = new Map();
    allClauses.forEach(c => {
      if (!clausesByRule.has(c.rule_id)) clausesByRule.set(c.rule_id, []);
      clausesByRule.get(c.rule_id).push(c);
    });

    // Batch-load all designations
    const clauseIds = allClauses.map(c => c.id);
    let allDesignations = [];
    if (clauseIds.length) {
      const clausePh = clauseIds.map(() => '?').join(',');
      [allDesignations] = await pool.query(
        `SELECT * FROM merit_list_designations WHERE clause_id IN (${clausePh}) AND org_id = ?`,
        [...clauseIds, orgId]
      );
    }
    const designationsByClause = new Map();
    allDesignations.forEach(d => {
      if (!designationsByClause.has(d.clause_id)) designationsByClause.set(d.clause_id, []);
      designationsByClause.get(d.clause_id).push(d);
    });

    const designationPresentations = buildDesignationPresentations(allDesignations, lookups);
    const presentationById = new Map(designationPresentations.map((item) => [item.id, item]));

    const groups = [];
    for (const rule of meritRules) {
      const clauses = clausesByRule.get(rule.id) || [];
      for (const clause of clauses) {
        const designations = designationsByClause.get(clause.id) || [];
        const members = [];
        for (const d of designations) {
          const member = presentationById.get(safeString(d.id));
          if (!member) continue;
          members.push({
            id: member.targetAssignmentId || member.targetHrId,
            targetAssignmentId: member.targetAssignmentId,
            targetHrId: member.targetHrId,
            personId: member.personId,
            name: member.name,
            studentId: member.studentId,
            departmentId: member.departmentId,
            department: member.department,
            identityId: member.identityId,
            identity: member.identity,
            workGroupId: member.workGroupId,
            workGroup: member.workGroup,
            assignmentNature: member.assignmentNature,
            assignmentLabel: member.assignmentLabel,
            historicalAssignmentUnavailable: member.historicalAssignmentUnavailable
          });
        }
        const targetIdentityName = lookups.identitiesById.get(safeString(clause.target_identity_id)) || '';
        const granteeDepartmentName = lookups.departmentsById.get(safeString(rule.grantee_department_id)) || '';
        const granteeIdentityName = lookups.identitiesById.get(safeString(rule.grantee_identity_id)) || '';
        groups.push({
          clauseId: clause.id,
          granteeDepartment: granteeDepartmentName,
          granteeIdentity: granteeIdentityName,
          targetIdentity: targetIdentityName,
          scopeType: clause.scope_type,
          quotaLimit: clause.quota_limit || 0,
          requireExactQuota: (clause.require_exact_quota === 1),
          memberCount: members.length,
          members
        });
      }
    }

    // Build filter options from all members
    const deptSet = new Set(), identSet = new Set(), wgSet = new Set();
    for (const g of groups) {
      for (const m of g.members) {
        if (m.department) deptSet.add(m.department);
        if (m.identity) identSet.add(m.identity);
        if (m.workGroup) wgSet.add(m.workGroup);
      }
    }

    res.json({
      status: 'success',
      groups,
      departmentOptions: Array.from(deptSet).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      identityOptions: Array.from(identSet).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      workGroupOptions: Array.from(wgSet).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

// ─── exportMeritListSummary (admin) ───
router.post('/exportMeritListSummary', async (req, res) => {
  try {
    const admin = await resolveAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });
    const activityId = safeString(req.body.activityId);
    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_21368b3e76 });

    const filterDepartment = safeString(req.body.filterDepartment || '');
    const filterIdentity = safeString(req.body.filterIdentity || '');
    const filterWorkGroup = safeString(req.body.filterWorkGroup || '');

    const orgId = await getCurrentOrgId();
    const publication = await publicationModel.getByActivity(activityId);
    if (!publication) return res.json({ status: 'not_found', message: localeCopy.copy_c2ca4efbfa });

    const lookups = await fetchOrgLookups();
    const [meritRules] = await pool.query('SELECT * FROM pub_merit_rules WHERE publication_id = ? AND org_id = ?', [publication.id, orgId]);
    if (!meritRules.length) {
      return res.json({ status: 'success', fileContent: '', fileName: localeCopy.copy_08f97574f4, extension: 'xlsx', rowCount: 0 });
    }

    // Batch-load ALL clauses for ALL rules in a single query
    const ruleIds = meritRules.map(r => r.id);
    const rulePh = ruleIds.map(() => '?').join(',');
    const [allClauses] = await pool.query(
      `SELECT * FROM pub_merit_rule_clauses WHERE rule_id IN (${rulePh}) AND org_id = ? ORDER BY sort_order`,
      [...ruleIds, orgId]
    );
    const clausesByRule = new Map();
    allClauses.forEach(c => {
      if (!clausesByRule.has(c.rule_id)) clausesByRule.set(c.rule_id, []);
      clausesByRule.get(c.rule_id).push(c);
    });

    // Batch-load ALL designations for ALL clauses in a single query
    const clauseIds = allClauses.map(c => c.id);
    let allDesignations = [];
    if (clauseIds.length) {
      const clausePh = clauseIds.map(() => '?').join(',');
      [allDesignations] = await pool.query(
        `SELECT * FROM merit_list_designations WHERE clause_id IN (${clausePh}) AND org_id = ?`,
        [...clauseIds, orgId]
      );
    }
    const designationsByClause = new Map();
    allDesignations.forEach(d => {
      if (!designationsByClause.has(d.clause_id)) designationsByClause.set(d.clause_id, []);
      designationsByClause.get(d.clause_id).push(d);
    });

    const designationPresentations = buildDesignationPresentations(allDesignations, lookups);
    const presentationById = new Map(designationPresentations.map((item) => [item.id, item]));

    const rows = [];
    const EXPORT_MAX_ROWS = 50000;

    for (const rule of meritRules) {
      const clauses = clausesByRule.get(rule.id) || [];
      for (const clause of clauses) {
        const designations = designationsByClause.get(clause.id) || [];
        const targetIdentityName = lookups.identitiesById.get(safeString(clause.target_identity_id)) || '';
        const granteeDepartmentName = lookups.departmentsById.get(safeString(rule.grantee_department_id)) || '';
        const granteeIdentityName = lookups.identitiesById.get(safeString(rule.grantee_identity_id)) || '';
        const groupLabel = `${granteeDepartmentName} ${granteeIdentityName} → ${targetIdentityName}`;
        for (const d of designations) {
          const member = presentationById.get(safeString(d.id));
          if (!member) continue;
          const dept = member.department;
          const ident = member.identity;
          const wg = member.workGroup;

          // Apply filters
          if (filterDepartment && dept !== filterDepartment) continue;
          if (filterIdentity && ident !== filterIdentity) continue;
          if (filterWorkGroup && wg !== filterWorkGroup) continue;

          // Safety cap
          if (rows.length >= EXPORT_MAX_ROWS) break;

          rows.push({
            name: member.name,
            studentId: member.studentId,
            department: dept,
            identity: ident,
            workGroup: wg,
            groupLabel
          });
        }
        if (rows.length >= EXPORT_MAX_ROWS) break;
      }
      if (rows.length >= EXPORT_MAX_ROWS) break;
    }

    if (rows.length >= EXPORT_MAX_ROWS) {
      return res.json({
        status: 'too_large',
        message: localeFormat(localeCopy.copy_7188e5ac79, [EXPORT_MAX_ROWS]),
        rowCount: rows.length,
        maxAllowed: EXPORT_MAX_ROWS
      });
    }

    // Build XLSX file (same pattern as exportScoreResults)
    const headers = [
      { key: 'name', label: localeCopy.copy_3c946202ff },
      { key: 'studentId', label: localeCopy.copy_cbb853db1b },
      { key: 'department', label: localeCopy.copy_bc011e4e3b },
      { key: 'identity', label: localeCopy.copy_474f638a6f },
      { key: 'workGroup', label: localeCopy.copy_be736f763d },
      { key: 'groupLabel', label: localeCopy.copy_9984065ffd }
    ];
    const headerLabels = headers.map(h => h.label);
    const dataRows = rows.map(row => headers.map(h => row[h.key]));
    const sheetData = [headerLabels, ...dataRows];
    const buffer = await buildWorkbookBuffer(scoringCopy.exportMeritListSummary, sheetData);
    const fileContent = buffer.toString('base64');

    res.json({ status: 'success', fileContent, fileName: localeCopy.copy_08f97574f4, extension: 'xlsx', rowCount: rows.length });
  } catch (e) { res.json({ status: 'error', message: safeString(e.message) }); }
});

module.exports = router;
