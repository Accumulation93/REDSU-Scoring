const localeCopy = require('../../../locales/zh-CN/generated/modules/scoring/routes/results');
const scoringCopy = require('../../../locales/zh-CN/modules/scoring');
const { format: localeFormat } = require('../../../locales/runtime');
const express = require('express');
const router = express.Router();
const { safeString, toNumber, roundScore, buildOrgMap, makeOrgRuleKey } = require('../../../utils/helpers');
const { resolveRequestAdmin: ensureAdmin } = require('../../../core/services/adminRequestContext');
const activityModel = require('../models/scoreActivity');
const departmentModel = require('../../../core/models/department');
const identityModel = require('../../../core/models/identity');
const workGroupModel = require('../../../core/models/workGroup');
const templateModel = require('../models/scoreTemplate');
const questionModel = require('../models/scoreQuestion');
const rateRuleModel = require('../models/rateRule');
const rateRuleClauseModel = require('../models/rateRuleClause');
const clauseTemplateConfigModel = require('../models/clauseTemplateConfig');
const scoreRecordModel = require('../models/scoreRecord');
const scoreAnswerModel = require('../models/scoreAnswer');
const systemConfigModel = require('../../../core/models/systemConfig');
const pool = require('../../../config/db');
const { getCurrentOrgId } = require('../../../utils/orgContext');
const sharedCache = require('../utils/sharedCache');
const { buildWorkbookBuffer } = require('../../../utils/excelFile');
const participantService = require('../services/participants');
const {
  validateCalculationSnapshot,
  getHistoricalSnapshotFailure,
  buildAggregationPolicySignature
} = require('../utils/scoreCalc');

const DEFAULT_WORK_GROUP = '';
const RESPONSE_SAFE_LIMIT = 850 * 1024;
const EXPORT_MAX_ROWS = 50000; // Safety cap to prevent OOM from excessive export data

function decorateAssignmentRows(rows) {
  if (typeof participantService.decorateAssignmentDisambiguation === 'function') {
    return participantService.decorateAssignmentDisambiguation(rows);
  }
  return { rows: Array.isArray(rows) ? rows : [], needsAssignmentDisambiguation: false };
}

async function buildXlsxBase64(sheetName, headers, rows) {
  const headerLabels = headers.map(h => h.label);
  const dataRows = rows.map(row => headers.map(h => row[h.key]));
  const sheetData = [headerLabels, ...dataRows];
  const buffer = await buildWorkbookBuffer(sheetName, sheetData);
  return buffer.toString('base64');
}

function getLookupName(map, id) {
  const row = map && map.get(safeString(id));
  return row ? safeString(row.name) : '';
}

function getScorerUniqueKey(memberOrRecord) {
  return safeString(memberOrRecord.scorerId || memberOrRecord.id) || safeString(memberOrRecord.studentId);
}

// ---------- Data loading helpers ----------

const _orgLookupsCache = new Map();
const ORG_LOOKUPS_CACHE_TTL = 60000;

// ─── Overview result cache (avoids recomputing scores on every page request) ───
// Uses MySQL-backed shared cache so all PM2 instances see the same state.
const OVERVIEW_CACHE_TTL = 30 * 60 * 1000; // 30 minutes; score writes invalidate this cache immediately

function getOverviewCacheKey(orgId, activityId, dataType, filters) {
  const dept = safeString(filters && filters.department);
  const ident = safeString(filters && filters.identity);
  const wg = safeString(filters && filters.workGroup);
  return `overview_${orgId}_${activityId}_${dataType}_${dept}_${ident}_${wg}`;
}

async function getCachedOverview(cacheKey) {
  return sharedCache.get(cacheKey);
}

async function setCachedOverview(cacheKey, data) {
  return sharedCache.set(cacheKey, data, OVERVIEW_CACHE_TTL);
}

async function fetchOrgLookups(explicitOrgId) {
  const orgId = safeString(explicitOrgId) || await getCurrentOrgId();
  const now = Date.now();
  const cached = _orgLookupsCache.get(orgId);
  if (cached && (now - cached.timestamp) < ORG_LOOKUPS_CACHE_TTL) {
    return cached.value;
  }
  const [departments, identities, workGroups, templates] = await Promise.all([
    departmentModel.getAll(), identityModel.getAll(), workGroupModel.getAll(),
    templateModel.getAll(orgId)
  ]);
  const templateIds = templates.map((item) => safeString(item.id)).filter(Boolean);
  const scopedQuestions = templateIds.length
    ? await questionModel.getByTemplateIds(templateIds)
    : [];
  const templatesById = new Map();
  const questionsByTemplate = new Map();
  scopedQuestions.forEach((q) => {
    if (!questionsByTemplate.has(q.template_id)) questionsByTemplate.set(q.template_id, []);
    questionsByTemplate.get(q.template_id).push(q);
  });
  templates.forEach((t) => {
    templatesById.set(t.id, {
      id: t.id, name: safeString(t.name),
      questionCount: (questionsByTemplate.get(t.id) || []).length,
      questions: (questionsByTemplate.get(t.id) || []).map((q) => ({
        question: q.question, scoreLabel: q.score_label,
        minValue: Number(q.min_value), startValue: Number(q.start_value),
        maxValue: Number(q.max_value), stepValue: Number(q.step_value)
      }))
    });
  });
  const result = {
    departmentsById: buildOrgMap(departments),
    identitiesById: buildOrgMap(identities),
    workGroupsById: buildOrgMap(workGroups),
    templatesById
  };
  _orgLookupsCache.set(orgId, { value: result, timestamp: now });
  return result;
}

function buildActivityNotFoundPayload(dataType) {
  return {
    status: 'activity_not_found',
    message: localeCopy.copy_83aacffc9f,
    activity: null,
    overviewRows: [],
    calculationRows: [],
    detailRows: [],
    recordRows: [],
    targetRecordRows: [],
    scorerTargetRows: [],
    recordDetail: null,
    scorerCompletionRows: [],
    completionBoards: { departments: [], identities: [], workGroups: [] },
    stats: { totalMembers: 0, scoredMembers: 0, recordCount: 0, completedMembers: 0 },
    filterOptions: { departments: [], identities: [], workGroups: [] },
    pagination: { total: 0, returnedCount: 0, nextOffset: 0, hasMore: false },
    dataType: safeString(dataType) || 'overview'
  };
}

function buildTemplateConfigSignature(templateConfigs, templatesById) {
  return (templateConfigs || [])
    .map(config => {
      const template = templatesById.get(safeString(config.templateId));
      if (!template || !Array.isArray(template.questions) || !template.questions.length) return '';
      // Use question count instead of full parameters so that score-range changes
      // (min/start/max/step) do not invalidate existing score records
      const qCount = template.questions.length;
      const method = safeString(config.calculationMethod || config.calculation_method) || 'weighted_average';
      const trimH = Number(config.trimHighCount || config.trim_high_count || 0);
      const trimL = Number(config.trimLowCount || config.trim_low_count || 0);
      return `${safeString(config.templateId)}[${qCount}|${method}|${trimH}|${trimL}]`;
    })
    .filter(Boolean)
    .join('|');
}

/**
 * Normalize a legacy (full-parameter) signature to the structure-only format.
 * Legacy format: templateId[min:start:max:step,...|method|trimH|trimL]
 * Structure format: templateId[questionCount|method|trimH|trimL]
 * Returns null if the signature cannot be parsed.
 */
function normalizeSignatureToStructure(sig) {
  if (!sig) return null;
  // Split by top-level '|' (outside brackets) to get per-template entries
  let parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < sig.length; i++) {
    if (sig[i] === '[') depth++;
    else if (sig[i] === ']') depth--;
    else if (sig[i] === '|' && depth === 0) { parts.push(sig.substring(start, i)); start = i + 1; }
  }
  parts.push(sig.substring(start));

  let normalized = parts.map(function(part) {
    let bracketIdx = part.indexOf('[');
    if (bracketIdx === -1) return part;
    let templateId = part.substring(0, bracketIdx);
    let inner = part.substring(bracketIdx + 1, part.length - 1);
    // Inner format: questionData|method|trimH|trimL
    // Split by ALL '|' — last 3 parts are method, trimH, trimL
    let innerParts = inner.split('|');
    if (innerParts.length < 4) return part;
    let methodAndTrim = innerParts.slice(-3).join('|');
    let beforeMethod = innerParts.slice(0, -3).join('|');
    let questionCount;
    if (beforeMethod.indexOf(':') !== -1) {
      // Legacy format: min:start:max:step,min:start:max:step,...
      questionCount = beforeMethod.split(',').filter(function(s) { return s.indexOf(':') !== -1; }).length;
    } else {
      // Already normalized: just a number
      questionCount = parseInt(beforeMethod, 10);
      if (isNaN(questionCount)) return part;
    }
    return templateId + '[' + questionCount + '|' + methodAndTrim + ']';
  });
  return normalized.join('|');
}
function normalizeMember(record, orgLookups) {
  const departmentId = safeString(record.department_id);
  const identityId = safeString(record.identity_id);
  const workGroupId = safeString(record.work_group_id);
  return {
    id: safeString(record.id),
    legacyHrId: safeString(record.legacy_hr_id || record.id),
    personId: safeString(record.person_id),
    assignmentId: safeString(record.assignment_id),
    assignmentNature: safeString(record.assignment_kind),
    assignmentLabel: participantService.buildAssignmentLabel({
      ...record,
      department: getLookupName(orgLookups.departmentsById, departmentId),
      identityCategory: getLookupName(orgLookups.identitiesById, identityId),
      workGroup: getLookupName(orgLookups.workGroupsById, workGroupId)
    }),
    name: safeString(record.name),
    studentId: safeString(record.student_id),
    departmentId, department: getLookupName(orgLookups.departmentsById, departmentId),
    identityId, identity: getLookupName(orgLookups.identitiesById, identityId),
    workGroupId, workGroup: getLookupName(orgLookups.workGroupsById, workGroupId) || DEFAULT_WORK_GROUP
  };
}

function mergeHistoricalTargets(currentMembers, targetSnapshots) {
  const merged = new Map((currentMembers || []).map((member) => [safeString(member.id), member]));
  if (!(targetSnapshots instanceof Map)) return Array.from(merged.values());
  targetSnapshots.forEach((target, targetId) => {
    const id = safeString(targetId || target && target.participantId);
    if (!id || merged.has(id)) return;
    const context = target && target.context || {};
    merged.set(id, {
      id,
      legacyHrId: safeString(context.legacyHrId),
      personId: safeString(target && target.personId || context.personId),
      assignmentId: safeString(target && target.assignmentId || context.assignmentId || id),
      assignmentNature: safeString(context.assignmentNature),
      assignmentLabel: safeString(context.assignmentLabel),
      name: safeString(context.name),
      studentId: safeString(context.studentId),
      departmentId: safeString(context.departmentId),
      department: safeString(context.department),
      identityId: safeString(context.identityCategoryId),
      identity: safeString(context.identityCategory),
      workGroupId: safeString(context.workGroupId),
      workGroup: safeString(context.workGroup),
      historicalOnly: true
    });
  });
  return Array.from(merged.values());
}

function normalizeRuleClause(rawClause, orgLookups) {
  const targetIdentityId = safeString(rawClause.target_identity_id);
  return {
    scopeType: safeString(rawClause.scope_type),
    targetIdentityId,
    targetIdentity: getLookupName(orgLookups.identitiesById, targetIdentityId),
    requireAllComplete: !!rawClause.require_all_complete,
    templateConfigs: []
  };
}

async function loadRulesWithClauses(activityId, orgLookups) {
  const rulesRaw = await rateRuleModel.getByActivity(activityId);
  if (!rulesRaw.length) return [];
  const ruleIds = rulesRaw.map((r) => r.id);
  const allClauses = await rateRuleClauseModel.getByRuleIds(ruleIds);
  const clauseIds = allClauses.map((c) => c.id);
  const allConfigs = clauseIds.length ? await clauseTemplateConfigModel.getByClauseIds(clauseIds) : [];

  const configsByClause = new Map();
  allConfigs.forEach((cfg) => {
    if (!configsByClause.has(cfg.clause_id)) configsByClause.set(cfg.clause_id, []);
    configsByClause.get(cfg.clause_id).push(cfg);
  });

  return rulesRaw.map((item) => {
    const clauses = allClauses.filter((c) => c.rule_id === item.id).sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => {
        const configs = (configsByClause.get(c.id) || []).sort((a, b) => a.sort_order - b.sort_order)
          .map((cfg) => ({
            templateId: cfg.template_id, templateName: getLookupName(orgLookups.templatesById, cfg.template_id),
            weight: Number(cfg.weight), sortOrder: Number(cfg.sort_order),
            calculationMethod: safeString(cfg.calculation_method) || 'weighted_average',
            trimHighCount: Number(cfg.trim_high_count || 0),
            trimLowCount: Number(cfg.trim_low_count || 0)
          }));
        return {
          ...normalizeRuleClause(c, orgLookups), templateConfigs: configs
        };
      });
    return {
      _id: item.id, _raw: item,
      scorerKey: item.scorer_key,
      scorerDepartmentId: item.scorer_department_id,
      scorerIdentityId: item.scorer_identity_id,
      scorerDepartment: getLookupName(orgLookups.departmentsById, item.scorer_department_id),
      scorerIdentity: getLookupName(orgLookups.identitiesById, item.scorer_identity_id),
      allowSelfAssessment: item.allow_self_assessment !== 0,
      clauses
    };
  });
}

// ---------- Matching and scoring helpers ----------

function sameDepartment(left, right) {
  return safeString(left.departmentId) && safeString(left.departmentId) === safeString(right.departmentId);
}
function sameWorkGroup(left, right) {
  return safeString(left.workGroupId) && safeString(left.workGroupId) === safeString(right.workGroupId);
}
function matchesTargetIdentity(target, clause) {
  return safeString(target.identityId) && safeString(target.identityId) === safeString(clause.targetIdentityId);
}
function matchesClauseTarget(target, scorer, clause) {
  const st = safeString(clause.scopeType);
  if (st === 'same_department_identity') return sameDepartment(target, scorer) && matchesTargetIdentity(target, clause);
  if (st === 'same_department_all') return sameDepartment(target, scorer);
  if (st === 'same_work_group_identity') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer) && matchesTargetIdentity(target, clause);
  if (st === 'same_work_group_all') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer);
  if (st === 'identity_only') return matchesTargetIdentity(target, clause);
  if (st === 'all_people') return true;
  return false;
}

function getMemberRuleKey(member) {
  return makeOrgRuleKey(member.departmentId, member.identityId);
}

function createScorerKeyResolver(members) {
  const aliasMap = new Map();
  members.forEach((member) => {
    const canonicalKey = getScorerUniqueKey(member);
    [member.id, member.studentId, member.scorerId].forEach((value) => {
      const key = safeString(value);
      if (key) aliasMap.set(key, canonicalKey);
    });
  });
  return function resolveScorerKey(record) {
    const rawKeys = [record.scorerId, record.id].map((v) => safeString(v)).filter(Boolean);
    for (const key of rawKeys) { if (aliasMap.has(key)) return aliasMap.get(key); }
    return rawKeys[0] || '';
  };
}

function buildTaskData(members, rules, records) {
  const resolveScorerKey = createScorerKeyResolver(members);
  const membersByRuleKey = new Map();
  members.forEach((member) => {
    const key = getMemberRuleKey(member);
    if (!membersByRuleKey.has(key)) membersByRuleKey.set(key, []);
    membersByRuleKey.get(key).push(member);
  });

  // Pre-index members by identity, department, and dept+workGroup for O(1) subset lookup
  const membersByIdentity = new Map();
  const membersByDept = new Map();
  const membersByDeptWG = new Map();
  members.forEach((m) => {
    const identId = safeString(m.identityId);
    const deptId = safeString(m.departmentId);
    const wgKey = deptId + '::' + safeString(m.workGroupId);

    if (!membersByIdentity.has(identId)) membersByIdentity.set(identId, []);
    membersByIdentity.get(identId).push(m);

    if (!membersByDept.has(deptId)) membersByDept.set(deptId, []);
    membersByDept.get(deptId).push(m);

    if (!membersByDeptWG.has(wgKey)) membersByDeptWG.set(wgKey, []);
    membersByDeptWG.get(wgKey).push(m);
  });

  const expectedPairs = new Map();
  const scorerTaskMap = new Map();

  rules.forEach((rule) => {
    const ruleKey = makeOrgRuleKey(rule.scorerDepartmentId, rule.scorerIdentityId);
    const scorers = membersByRuleKey.get(ruleKey) || [];
    rule.clauses.forEach((clause, clauseIndex) => {
      if (!clause.templateConfigs.length) return;
      const scopeType = safeString(clause.scopeType);
      scorers.forEach((scorer) => {
        const scorerKey = getScorerUniqueKey(scorer);
        // Resolve target candidates based on scope type (equivalent to matchesClauseTarget)
        let candidates;
        if (scopeType === 'same_department_identity') {
          candidates = (membersByDept.get(safeString(scorer.departmentId)) || [])
            .filter((t) => safeString(t.identityId) === safeString(clause.targetIdentityId));
        } else if (scopeType === 'same_department_all') {
          candidates = membersByDept.get(safeString(scorer.departmentId)) || [];
        } else if (scopeType === 'same_work_group_identity') {
          candidates = (membersByDeptWG.get(safeString(scorer.departmentId) + '::' + safeString(scorer.workGroupId)) || [])
            .filter((t) => safeString(t.identityId) === safeString(clause.targetIdentityId));
        } else if (scopeType === 'same_work_group_all') {
          candidates = membersByDeptWG.get(safeString(scorer.departmentId) + '::' + safeString(scorer.workGroupId)) || [];
        } else if (scopeType === 'identity_only') {
          candidates = membersByIdentity.get(safeString(clause.targetIdentityId)) || [];
        } else {
          candidates = members; // 'all_people' or unknown
        }

        candidates.forEach((target) => {
          if (!rule.allowSelfAssessment && participantService.isSameNaturalPerson(scorer, target)) return;
          const taskKey = `${safeString(rule._id)}::${clauseIndex}::${scorerKey}::${target.id}`;
          expectedPairs.set(taskKey, {
            taskKey, pairKey: `${scorerKey}::${target.id}`,
            ruleId: safeString(rule._id), clauseIndex,
            requireAllComplete: clause.requireAllComplete === true,
            scorerKey, scorerId: scorer.id, scorerName: scorer.name,
            scorerStudentId: scorer.studentId,
            scorerPersonId: scorer.personId, scorerAssignmentId: scorer.assignmentId,
            scorerAssignmentKind: scorer.assignmentKind,
            scorerDepartmentId: scorer.departmentId, scorerIdentityId: scorer.identityId,
            scorerWorkGroupId: scorer.workGroupId,
            scorerDepartment: scorer.department, scorerIdentity: scorer.identity,
            scorerWorkGroup: scorer.workGroup || DEFAULT_WORK_GROUP,
            targetId: target.id, targetName: target.name, targetStudentId: target.studentId,
            targetDepartment: target.department, targetIdentity: target.identity,
            targetWorkGroup: target.workGroup || DEFAULT_WORK_GROUP,
            templateConfigs: clause.templateConfigs
          });
        });
      });
    });
  });

  expectedPairs.forEach((task) => {
    if (!scorerTaskMap.has(task.scorerKey)) {
      scorerTaskMap.set(task.scorerKey, {
        scorerKey: task.scorerKey, scorerId: task.scorerId,
        scorerName: task.scorerName, scorerStudentId: task.scorerStudentId,
        personId: task.scorerPersonId, assignmentId: task.scorerAssignmentId,
        assignmentKind: task.scorerAssignmentKind,
        departmentId: task.scorerDepartmentId, identityId: task.scorerIdentityId,
        workGroupId: task.scorerWorkGroupId,
        department: task.scorerDepartment, identity: task.scorerIdentity,
        workGroup: task.scorerWorkGroup,
        expectedTaskKeys: new Set(), submittedTaskKeys: new Set()
      });
    }
    scorerTaskMap.get(task.scorerKey).expectedTaskKeys.add(task.taskKey);
  });

  const pairRecordsMap = new Map();
  records.forEach((record) => {
    const scorerKey = resolveScorerKey(record);
    const targetId = safeString(record.targetId);
    if (!scorerKey || !targetId) return;
    const pairKey = `${scorerKey}::${targetId}`;
    if (!pairRecordsMap.has(pairKey)) pairRecordsMap.set(pairKey, []);
    pairRecordsMap.get(pairKey).push(record);
  });

  expectedPairs.forEach((task) => {
    const taskRecords = pairRecordsMap.get(task.pairKey) || [];
    const hasRecord = taskRecords.some((r) => safeString(r.ruleId) === task.ruleId);
    if (!hasRecord) return;
    const scorerStat = scorerTaskMap.get(task.scorerKey);
    if (scorerStat) scorerStat.submittedTaskKeys.add(task.taskKey);
  });

  // Calculate invalidScorerClauseKeys for requireAllComplete clauses
  const invalidScorerClauseKeys = new Set();
  const scorerClauseTaskMap = new Map();
  expectedPairs.forEach((task) => {
    const key = `${task.ruleId}::${task.clauseIndex}::${task.scorerKey}`;
    if (!scorerClauseTaskMap.has(key)) scorerClauseTaskMap.set(key, { requireAllComplete: task.requireAllComplete, tasks: [] });
    scorerClauseTaskMap.get(key).tasks.push(task);
  });
  scorerClauseTaskMap.forEach((bucket, key) => {
    if (!bucket.requireAllComplete) return;
    const hasPending = bucket.tasks.some((task) => {
      const scorerStat = scorerTaskMap.get(task.scorerKey);
      return scorerStat && !scorerStat.submittedTaskKeys.has(task.taskKey);
    });
    if (hasPending) invalidScorerClauseKeys.add(key);
  });

  const scorerTaskRows = Array.from(scorerTaskMap.values()).map((item) => ({
    scorerKey: item.scorerKey, scorerId: item.scorerId, scorerName: item.scorerName,
    scorerStudentId: item.scorerStudentId,
    personId: item.personId, assignmentId: item.assignmentId, assignmentKind: item.assignmentKind,
    departmentId: item.departmentId, identityId: item.identityId, workGroupId: item.workGroupId,
    department: item.department,
    identity: item.identity, workGroup: item.workGroup,
    expectedCount: item.expectedTaskKeys.size, submittedCount: item.submittedTaskKeys.size,
    pendingCount: Math.max(item.expectedTaskKeys.size - item.submittedTaskKeys.size, 0),
    completionRate: item.expectedTaskKeys.size ? Number(((item.submittedTaskKeys.size / item.expectedTaskKeys.size) * 100).toFixed(2)) : 0
  })).sort((a, b) => {
    if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount;
    return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN');
  });

  return { scorerTaskRows, expectedPairs: Array.from(expectedPairs.values()), invalidScorerClauseKeys };
}

// ── Lightweight scorer completion data using arithmetic counting ──
// Replaces buildTaskData for the 'completion' dataType.
// Uses the same arithmetic approach as computeValidScoreMap's includeCounts
// section: O(targets + scorers) per clause instead of O(scorers × targets).
function computeScorerCompletionData(members, rules, records) {
  const resolveScorerKey = createScorerKeyResolver(members);

  // Pre-index members by rule key for scorer lookup
  const membersByRuleKey = new Map();
  members.forEach(function (m) {
    let key = getMemberRuleKey(m);
    if (!membersByRuleKey.has(key)) membersByRuleKey.set(key, []);
    membersByRuleKey.get(key).push(safeString(m.id));
  });

  // Pre-index members by department, identity, and dept+workGroup
  let membersByDept = new Map();
  let membersByIdentity = new Map();
  let hrByDeptWGMap = new Map();
  members.forEach(function (m) {
    let did = safeString(m.departmentId);
    let iid = safeString(m.identityId);
    let wid = safeString(m.workGroupId);

    if (!membersByDept.has(did)) membersByDept.set(did, []);
    membersByDept.get(did).push(safeString(m.id));

    if (!membersByIdentity.has(iid)) membersByIdentity.set(iid, []);
    membersByIdentity.get(iid).push(safeString(m.id));

    // For WG scopes: dept → wgId → [memberIds]
    if (!hrByDeptWGMap.has(did)) hrByDeptWGMap.set(did, new Map());
    let inner = hrByDeptWGMap.get(did);
    if (!inner.has(wid)) inner.set(wid, []);
    inner.get(wid).push(safeString(m.id));
  });

  // memberId → member for fast lookup
  let memberById = new Map(members.map(function (m) { return [safeString(m.id), m]; }));

  // ── Arithmetic expected counts (same algorithm as computeValidScoreMap) ──
  let scorerExpectedCount = new Map(); // scorerKey → number
  let expectedByCount = new Map();     // targetId → number

  rules.forEach(function (rule) {
    let ruleKey = makeOrgRuleKey(rule.scorerDepartmentId, rule.scorerIdentityId);
    let scorerIds = membersByRuleKey.get(ruleKey) || [];
    if (!scorerIds.length) return;
    let allowSelf = rule.allowSelfAssessment;

    rule.clauses.forEach(function (clause) {
      if (!clause.templateConfigs.length) return;
      let st = safeString(clause.scopeType);
      let targetIdentityId = safeString(clause.targetIdentityId);

      // ── Work-group scopes: per-WG arithmetic ──
      if (st === 'same_work_group_identity' || st === 'same_work_group_all') {
        let wgInner = hrByDeptWGMap.get(safeString(rule.scorerDepartmentId));
        if (!wgInner) return;
        wgInner.forEach(function (wgMemberIds, wgId) {
          let wgScorerIds = [];
          scorerIds.forEach(function (sid) {
            let m = memberById.get(sid);
            if (m && safeString(m.workGroupId) === wgId) wgScorerIds.push(sid);
          });
          if (!wgScorerIds.length) return;

          let wgTargetIds = wgMemberIds;
          if (st === 'same_work_group_identity' && targetIdentityId) {
            wgTargetIds = wgTargetIds.filter(function (tid) {
              let m = memberById.get(tid);
              return m && safeString(m.identityId) === targetIdentityId;
            });
          }
          if (!wgTargetIds.length) return;

          let scorerN = wgScorerIds.length;
          let targetN = wgTargetIds.length;

          wgTargetIds.forEach(function (tid) {
            let cnt = scorerN;
            if (!allowSelf) {
              const target = memberById.get(tid);
              cnt -= wgScorerIds.filter((sid) =>
                participantService.isSameNaturalPerson(memberById.get(sid), target)
              ).length;
            }
            expectedByCount.set(tid, (expectedByCount.get(tid) || 0) + cnt);
          });
          wgScorerIds.forEach(function (sid) {
            let cnt = targetN;
            if (!allowSelf) {
              const scorer = memberById.get(sid);
              cnt -= wgTargetIds.filter((tid) =>
                participantService.isSameNaturalPerson(scorer, memberById.get(tid))
              ).length;
            }
            scorerExpectedCount.set(sid, (scorerExpectedCount.get(sid) || 0) + cnt);
          });
        });
        return;
      }

      // ── Non-work-group scopes: O(targets + scorers) ──
      let targetIds;
      if (st === 'all_people') {
        targetIds = members.map(function (m) { return safeString(m.id); });
      } else if (st === 'identity_only') {
        targetIds = membersByIdentity.get(targetIdentityId) || [];
      } else if (st === 'same_department_identity') {
        targetIds = membersByDept.get(safeString(rule.scorerDepartmentId)) || [];
        if (targetIdentityId) {
          targetIds = targetIds.filter(function (tid) {
            let m = memberById.get(tid);
            return m && safeString(m.identityId) === targetIdentityId;
          });
        }
      } else if (st === 'same_department_all') {
        targetIds = membersByDept.get(safeString(rule.scorerDepartmentId)) || [];
      } else {
        return;
      }

      // Global targetIdentityId filter for scopes that don't pre-filter
      if (targetIdentityId && (st === 'all_people' || st === 'same_department_all')) {
        targetIds = targetIds.filter(function (tid) {
          let m = memberById.get(tid);
          return m && safeString(m.identityId) === targetIdentityId;
        });
      }

      if (!targetIds.length) return;

      let scorerN = scorerIds.length;
      let targetN = targetIds.length;

      // O(targets): per-target count = N_scorers (minus self)
      targetIds.forEach(function (tid) {
        let cnt = scorerN;
        if (!allowSelf) {
          const target = memberById.get(tid);
          cnt -= scorerIds.filter((sid) =>
            participantService.isSameNaturalPerson(memberById.get(sid), target)
          ).length;
        }
        expectedByCount.set(tid, (expectedByCount.get(tid) || 0) + cnt);
      });

      // O(scorers): per-scorer count = N_targets (minus self)
      scorerIds.forEach(function (sid) {
        let cnt = targetN;
        if (!allowSelf) {
          const scorer = memberById.get(sid);
          cnt -= targetIds.filter((tid) =>
            participantService.isSameNaturalPerson(scorer, memberById.get(tid))
          ).length;
        }
        scorerExpectedCount.set(sid, (scorerExpectedCount.get(sid) || 0) + cnt);
      });
    });
  });

  // ── Count submitted from records (unique scorer→target pairs) ──
  let submittedByScorer = new Map();
  let submittedByTarget = new Map();

  records.forEach(function (record) {
    let sk = resolveScorerKey(record);
    let tid = safeString(record.targetId);
    if (!sk || !tid) return;

    if (!submittedByScorer.has(sk)) submittedByScorer.set(sk, new Set());
    submittedByScorer.get(sk).add(tid);

    if (!submittedByTarget.has(tid)) submittedByTarget.set(tid, new Set());
    submittedByTarget.get(tid).add(sk);
  });

  // ── Build scorer task rows (O(M): direct member→row mapping, no .find()) ──
  let scorerTaskRows = members.map(function (member) {
    let sk = getScorerUniqueKey(member);
    let exp = scorerExpectedCount.get(sk) || 0;
    let subSet = submittedByScorer.get(sk) || new Set();
    let sub = subSet.size;
    return {
      scorerKey: sk,
      scorerId: member.id,
      scorerName: member.name,
      scorerStudentId: member.studentId,
      personId: member.personId,
      assignmentId: member.assignmentId,
      assignmentKind: member.assignmentKind,
      departmentId: member.departmentId,
      identityId: member.identityId,
      workGroupId: member.workGroupId,
      department: member.department,
      identity: member.identity,
      workGroup: member.workGroup || DEFAULT_WORK_GROUP,
      expectedCount: exp,
      submittedCount: sub,
      pendingCount: Math.max(exp - sub, 0),
      completionRate: exp ? Number(((sub / exp) * 100).toFixed(2)) : 0
    };
  }).sort(function (a, b) {
    if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount;
    return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN');
  });

  return { scorerTaskRows, expectedByCount, submittedByTarget, scorerExpectedCount };
}

function findExpectedPairTask(record, scorerKey, expectedPairs) {
  const ruleId = safeString(record.ruleId);
  const targetId = safeString(record.targetId);
  const aliases = [scorerKey, record.scorerId].map((v) => safeString(v)).filter(Boolean);
  const taskAliases = (task) => [task.scorerKey, task.scorerId].map((v) => safeString(v)).filter(Boolean);
  return (expectedPairs || []).find((item) =>
    safeString(item.targetId) === targetId &&
    safeString(item.ruleId) === ruleId &&
    taskAliases(item).some((alias) => aliases.includes(alias))
  ) || null;
}

function findCurrentTemplateConfig(rule, clauseIndex, templateId, fallback) {
  const clauses = Array.isArray(rule.clauses) ? rule.clauses : [];
  const normalizedTid = safeString(templateId);
  const clause = clauses[toNumber(clauseIndex, 0)] || {};
  const direct = (Array.isArray(clause.templateConfigs) ? clause.templateConfigs : [])
    .find((item) => safeString(item.templateId) === normalizedTid);
  if (direct) return direct;
  for (const item of clauses) {
    const cfg = (Array.isArray(item.templateConfigs) ? item.templateConfigs : [])
      .find((c) => safeString(c.templateId) === normalizedTid);
    if (cfg) return cfg;
  }
  return fallback || {};
}

function getCurrentTemplateWeight(rule, clauseIndex, templateId, fallback) {
  const cfg = findCurrentTemplateConfig(rule, clauseIndex, templateId, fallback);
  const weight = toNumber(cfg.weight, NaN);
  // If weight from current config is valid, use it; otherwise fall back to the item's own weight
  if (Number.isFinite(weight) && weight > 0) return weight;
  const fallbackWeight = toNumber(fallback && fallback.weight, NaN);
  if (Number.isFinite(fallbackWeight) && fallbackWeight > 0) return fallbackWeight;
  // Default to 1 to match DB DEFAULT and public results behavior
  return 1;
}

function getRecordTemplateScores(record) {
  const snapshot = record.calculationSnapshot || {};
  const templates = (Array.isArray(snapshot.templates) ? snapshot.templates : [])
    .map((template) => ({
      templateId: safeString(template.templateId),
      templateName: safeString(template.templateName),
      weight: toNumber(template.weight, 0),
      sortOrder: toNumber(template.sortOrder, 0),
      calculationMethod: safeString(template.calculationMethod) || 'weighted_average',
      trimHighCount: Number(template.trimHighCount || 0),
      trimLowCount: Number(template.trimLowCount || 0),
      questionCount: Array.isArray(template.questions) ? template.questions.length : 0,
      questions: Array.isArray(template.questions) ? template.questions : []
    }))
    .filter((item) => item.templateId)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const answers = Array.isArray(record.answers) ? record.answers : [];
  const answerMap = new Map(answers.map((item, index) => {
    const raw = item.questionIndex != null ? item.questionIndex : index;
    const hasZero = answers.some(a => a.questionIndex === 0);
    const key = hasZero ? raw + 1 : raw;
    return [String(key), toNumber(item.score, 0)];
  }));
  let cursor = 0;
  return templates.map((config) => {
    let score = 0;
    if (config.questionCount) {
      for (let i = 0; i < config.questionCount; i++) score += toNumber(answerMap.get(String(cursor + i + 1)), 0);
    } else {
      answers.filter((a) => safeString(a.templateId) === config.templateId).forEach((a) => { score += toNumber(a.score, 0); });
    }
    cursor += config.questionCount;
    return { ...config, score };
  });
}

function addSnapshotDiagnostic(diagnostics, recordId, reason) {
  diagnostics.skippedRecords += 1;
  diagnostics.reasons[reason] = (diagnostics.reasons[reason] || 0) + 1;
  if (diagnostics.records.length < 50) diagnostics.records.push({ recordId: safeString(recordId), reason });
}

function inspectImmutableRecords(records, activityId) {
  const diagnostics = {
    totalRecords: records.length,
    acceptedRecords: 0,
    skippedRecords: 0,
    reasons: {},
    records: []
  };
  const accepted = [];
  records.forEach((record) => {
    const validation = validateCalculationSnapshot(record, activityId);
    if (!validation.ok) {
      addSnapshotDiagnostic(diagnostics, record.id, validation.reason);
      return;
    }
    const answers = Array.isArray(record.answers) ? record.answers : [];
    const hasZeroBasedAnswer = answers.some((item) => Number(item.questionIndex) === 0);
    const answerIndexes = new Set(answers.map((item, index) => {
      const raw = item.questionIndex != null ? Number(item.questionIndex) : index + 1;
      return hasZeroBasedAnswer ? raw + 1 : raw;
    }));
    if (answerIndexes.size !== validation.questionCount) {
      addSnapshotDiagnostic(diagnostics, record.id, 'answer_count_mismatch');
      return;
    }
    for (let index = 1; index <= validation.questionCount; index += 1) {
      if (!answerIndexes.has(index)) {
        addSnapshotDiagnostic(diagnostics, record.id, 'answer_snapshot_mismatch');
        return;
      }
    }
    const snapshot = validation.snapshot;
    const scorerContext = snapshot.scorer.context || {};
    const targetContext = snapshot.target.context || {};
    accepted.push(Object.assign({}, record, {
      calculationSnapshot: snapshot,
      scorerId: safeString(snapshot.scorer.participantId),
      scorerPersonId: safeString(snapshot.scorer.personId),
      scorerAssignmentId: safeString(snapshot.scorer.assignmentId),
      scorerName: safeString(scorerContext.name),
      scorerStudentId: safeString(scorerContext.studentId),
      scorerDepartmentId: safeString(scorerContext.departmentId),
      scorerIdentityCategoryId: safeString(scorerContext.identityCategoryId),
      scorerIdentityId: safeString(scorerContext.identityCategoryId),
      scorerWorkGroupId: safeString(scorerContext.workGroupId),
      scorerDepartment: safeString(scorerContext.department),
      scorerIdentityCategory: safeString(scorerContext.identityCategory),
      scorerIdentity: safeString(scorerContext.identityCategory),
      scorerWorkGroup: safeString(scorerContext.workGroup),
      scorerAssignmentNature: safeString(scorerContext.assignmentNature),
      scorerAssignmentLabel: safeString(scorerContext.assignmentLabel),
      scorerHistoricalAssignmentUnavailable: false,
      targetId: safeString(snapshot.target.participantId),
      targetPersonId: safeString(snapshot.target.personId),
      targetAssignmentId: safeString(snapshot.target.assignmentId),
      targetName: safeString(targetContext.name),
      targetStudentId: safeString(targetContext.studentId),
      targetDepartmentId: safeString(targetContext.departmentId),
      targetIdentityCategoryId: safeString(targetContext.identityCategoryId),
      targetIdentityId: safeString(targetContext.identityCategoryId),
      targetWorkGroupId: safeString(targetContext.workGroupId),
      targetDepartment: safeString(targetContext.department),
      targetIdentityCategory: safeString(targetContext.identityCategory),
      targetIdentity: safeString(targetContext.identityCategory),
      targetWorkGroup: safeString(targetContext.workGroup),
      targetAssignmentNature: safeString(targetContext.assignmentNature),
      targetAssignmentLabel: safeString(targetContext.assignmentLabel),
      targetHistoricalAssignmentUnavailable: false,
      ruleId: safeString(snapshot.rule.id),
      templateConfigSignature: safeString(snapshot.templateConfigSignature)
    }));
    diagnostics.acceptedRecords += 1;
  });
  return { records: accepted, diagnostics };
}

function buildImmutableTaskData(records) {
  const targetBySubjectKey = new Map();
  const completionBuckets = new Map();
  const submittedByTarget = new Map();

  records.forEach((record) => {
    const snapshot = record.calculationSnapshot;
    targetBySubjectKey.set(safeString(snapshot.target.subjectKey), {
      targetId: safeString(snapshot.target.participantId),
      targetName: safeString(record.targetName),
      targetStudentId: safeString(record.targetStudentId),
      targetDepartment: safeString(record.targetDepartment),
      targetIdentity: safeString(record.targetIdentity),
      targetWorkGroup: safeString(record.targetWorkGroup)
    });
    const completionKey = safeString(snapshot.scorer.subjectKey)
      + '||' + safeString(snapshot.calculationPolicySignature);
    if (!completionBuckets.has(completionKey)) {
      completionBuckets.set(completionKey, {
        key: completionKey,
        scorerId: safeString(snapshot.scorer.participantId),
        scorerSubjectKey: safeString(snapshot.scorer.subjectKey),
        scorer: snapshot.scorer,
        requireAllComplete: snapshot.clause.requireAllComplete === true,
        requiredTargets: new Map(),
        submittedTargets: new Set(),
        recordIds: new Set()
      });
    }
    const bucket = completionBuckets.get(completionKey);
    snapshot.clause.requiredTargets.forEach((target) => {
      const subjectKey = safeString(target && target.subjectKey);
      if (subjectKey) bucket.requiredTargets.set(subjectKey, target);
    });
    bucket.submittedTargets.add(safeString(snapshot.target.subjectKey));
    bucket.recordIds.add(safeString(record.id));
    record.completionKey = completionKey;
    if (!submittedByTarget.has(record.targetId)) submittedByTarget.set(record.targetId, new Set());
    submittedByTarget.get(record.targetId).add(safeString(snapshot.scorer.participantId));
  });

  const excludedRecordIds = new Set();
  completionBuckets.forEach((bucket) => {
    if (!bucket.requireAllComplete) return;
    const incomplete = Array.from(bucket.requiredTargets.keys())
      .some((subjectKey) => !bucket.submittedTargets.has(subjectKey));
    if (incomplete) bucket.recordIds.forEach((recordId) => excludedRecordIds.add(recordId));
  });

  const scorerRowsById = new Map();
  const expectedPairs = [];
  completionBuckets.forEach((bucket) => {
    const context = bucket.scorer.context || {};
    if (!scorerRowsById.has(bucket.scorerId)) {
      scorerRowsById.set(bucket.scorerId, {
        scorerKey: bucket.scorerId,
        scorerId: bucket.scorerId,
        scorerName: safeString(context.name),
        scorerStudentId: safeString(context.studentId),
        personId: safeString(bucket.scorer.personId),
        assignmentId: safeString(bucket.scorer.assignmentId),
        assignmentKind: safeString(context.assignmentNature),
        assignmentLabel: safeString(context.assignmentLabel),
        departmentId: safeString(context.departmentId),
        identityId: safeString(context.identityCategoryId),
        workGroupId: safeString(context.workGroupId),
        department: safeString(context.department),
        identity: safeString(context.identityCategory),
        workGroup: safeString(context.workGroup),
        expectedKeys: new Set(),
        submittedKeys: new Set()
      });
    }
    const scorerRow = scorerRowsById.get(bucket.scorerId);
    bucket.requiredTargets.forEach((requiredTarget, subjectKey) => {
      scorerRow.expectedKeys.add(subjectKey);
      const target = targetBySubjectKey.get(subjectKey) || {
        targetId: safeString(requiredTarget.participantId || requiredTarget.assignmentId),
        targetName: '', targetStudentId: '', targetDepartment: '', targetIdentity: '', targetWorkGroup: ''
      };
      expectedPairs.push(Object.assign({}, target, {
        completionKey: bucket.key,
        scorerKey: bucket.scorerId,
        scorerId: bucket.scorerId,
        scorerName: scorerRow.scorerName,
        scorerStudentId: scorerRow.scorerStudentId,
        scorerDepartment: scorerRow.department,
        scorerIdentity: scorerRow.identity,
        scorerWorkGroup: scorerRow.workGroup,
        targetSubjectKey: subjectKey,
        requireAllComplete: bucket.requireAllComplete
      }));
    });
    bucket.submittedTargets.forEach((subjectKey) => scorerRow.submittedKeys.add(subjectKey));
  });

  const scorerTaskRows = Array.from(scorerRowsById.values()).map((row) => {
    const expectedCount = row.expectedKeys.size;
    const submittedCount = Array.from(row.submittedKeys).filter((key) => row.expectedKeys.has(key)).length;
    return Object.assign({}, row, {
      expectedKeys: undefined,
      submittedKeys: undefined,
      expectedCount,
      submittedCount,
      pendingCount: Math.max(expectedCount - submittedCount, 0),
      completionRate: expectedCount ? Number(((submittedCount / expectedCount) * 100).toFixed(2)) : 100
    });
  });

  return { completionBuckets, excludedRecordIds, expectedPairs, scorerTaskRows, submittedByTarget };
}

function findRecordScorerClauseKeyFromPairs(record, scorerKey, expectedPairs) {
  const ruleId = safeString(record.ruleId);
  const targetId = safeString(record.targetId);
  const aliases = [scorerKey, record.scorerId].map((v) => safeString(v)).filter(Boolean);
  const taskAliases = (task) => [task.scorerKey, task.scorerId].map((v) => safeString(v)).filter(Boolean);
  const task = (expectedPairs || []).find((item) =>
    safeString(item.targetId) === targetId &&
    safeString(item.ruleId) === ruleId &&
    taskAliases(item).some((alias) => aliases.includes(alias))
  );
  return `${ruleId}::${toNumber(task && task.clauseIndex, 0)}::${safeString(task ? task.scorerKey || scorerKey : scorerKey)}`;
}

async function enrichRecordsWithAnswers(records) {
  if (!records.length) return records.map((r) => ({ ...r, answers: [] }));
  const ids = records.map((r) => r.id);
  const answers = await scoreAnswerModel.getByRecordIds(ids);
  const answersByRecord = new Map();
  answers.forEach((a) => {
    if (!answersByRecord.has(a.record_id)) answersByRecord.set(a.record_id, []);
    answersByRecord.get(a.record_id).push({ questionIndex: a.question_index, score: Number(a.score), templateId: '' });
  });
  return records.map((r) => ({ ...r, answers: answersByRecord.get(r.id) || [] }));
}

function enrichScoreRecords(records, members, granularity) {
  return records.map((record) => {
    const scorer = participantService.resolveHistoricalParticipant(record, 'scorer', members);
    const target = participantService.resolveHistoricalParticipant(record, 'target', members);
    const scorerId = safeString(scorer.assignmentId) || participantService.participantRecordId(record, 'scorer', granularity);
    const targetId = safeString(target.assignmentId) || participantService.participantRecordId(record, 'target', granularity);
    const scorerSnapshot = scorer.contextSnapshot || {};
    const targetSnapshot = target.contextSnapshot || {};
    return {
      ...record,
      scorerId,
      targetId,
      ruleId: safeString(record.rule_id),
      submittedAt: record.submitted_at,
      scorerName: scorer.name,
      scorerStudentId: scorer.studentId,
      scorerPersonId: scorer.personId,
      scorerAssignmentId: scorer.assignmentId,
      scorerAssignmentNature: scorer.assignmentNature,
      scorerAssignmentLabel: scorer.assignmentLabel,
      scorerHistoricalAssignmentUnavailable: scorer.historicalAssignmentUnavailable,
      scorerDepartmentId: scorer.departmentId,
      scorerIdentityCategoryId: scorer.identityCategoryId,
      scorerIdentityId: scorer.identityCategoryId,
      scorerWorkGroupId: scorer.workGroupId,
      scorerDepartment: scorer.department,
      scorerIdentityCategory: scorer.identityCategory,
      scorerIdentity: scorer.identityCategory,
      scorerWorkGroup: scorer.workGroup,
      scorerContextSnapshot: scorerSnapshot,
      targetName: target.name,
      targetStudentId: target.studentId,
      targetPersonId: target.personId,
      targetAssignmentId: target.assignmentId,
      targetAssignmentNature: target.assignmentNature,
      targetAssignmentLabel: target.assignmentLabel,
      targetHistoricalAssignmentUnavailable: target.historicalAssignmentUnavailable,
      targetDepartmentId: target.departmentId,
      targetIdentityCategoryId: target.identityCategoryId,
      targetIdentityId: target.identityCategoryId,
      targetWorkGroupId: target.workGroupId,
      targetDepartment: target.department,
      targetIdentityCategory: target.identityCategory,
      targetIdentity: target.identityCategory,
      targetWorkGroup: target.workGroup,
      targetContextSnapshot: targetSnapshot,
      templateConfigSignature: safeString(record.template_config_signature),
      templateConfigs: []
    };
  });
}

function isAllFilter(value) {
  return !value || ['全部', '全部部门', '全部身份', '全部职能组', '全部工作分工', '全部工作分工（职能组）'].includes(value) || value === '鍏ㄩ儴';
}

function filterScorerRows(rows, filters) {
  const dept = safeString(filters.department);
  const ident = safeString(filters.identity);
  const wg = safeString(filters.workGroup);
  return rows.filter((row) => {
    if (!isAllFilter(dept) && safeString(row.department) !== dept) return false;
    if (!isAllFilter(ident) && safeString(row.identity) !== ident) return false;
    if (!isAllFilter(wg) && safeString(row.workGroup || DEFAULT_WORK_GROUP) !== wg) return false;
    return true;
  });
}

function filterOverviewRows(rows, filters) {
  // overview rows have same fields as scorer rows: department, identity, workGroup
  return filterScorerRows(rows, filters);
}

function filterDetailRows(rows, filters) {
  const dept = safeString(filters.department);
  const ident = safeString(filters.identity);
  const wg = safeString(filters.workGroup);
  return rows.filter((row) => {
    if (!isAllFilter(dept) && safeString(row.targetDepartment) !== dept) return false;
    if (!isAllFilter(ident) && safeString(row.targetIdentity) !== ident) return false;
    if (!isAllFilter(wg) && safeString(row.targetWorkGroup || DEFAULT_WORK_GROUP) !== wg) return false;
    return true;
  });
}

// ---------- Pagination ----------

function estimateBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}
function sliceRowsBySize(rows, offset, basePayload, fieldName) {
  const start = Math.max(0, Math.floor(toNumber(offset, 0)));
  const selected = [];
  for (let i = start; i < rows.length; i++) {
    selected.push(rows[i]);
    if (estimateBytes({ ...basePayload, [fieldName]: selected }) > RESPONSE_SAFE_LIMIT) {
      selected.pop();
      return { rows: selected, nextOffset: i, hasMore: true, total: rows.length };
    }
  }
  return { rows: selected, nextOffset: rows.length, hasMore: false, total: rows.length };
}

function applyCalcMethod(scores, weight, method, trimH, trimL) {
  if (!scores.length) return { averageScore: 0, contributionScore: 0 };
  if (method === 'trim_extremes') {
    let totalTrim = (trimH || 0) + (trimL || 0);
    if (scores.length < totalTrim) return { averageScore: 0, contributionScore: 0 };
    let sorted = scores.slice().sort(function(a, b) { return a - b; });
    let trimmed = sorted.slice(trimL || 0, scores.length - (trimH || 0));
    if (!trimmed.length) return { averageScore: 0, contributionScore: 0 };
    let avg = trimmed.reduce(function(s, v) { return s + v; }, 0) / trimmed.length;
    return { averageScore: roundScore(avg), contributionScore: roundScore(avg * weight) };
  }
  let avg = scores.reduce(function(s, v) { return s + v; }, 0) / scores.length;
  return { averageScore: roundScore(avg), contributionScore: roundScore(avg * weight) };
}

// ---------- Route handlers ----------

// getScoreResults
router.post('/getScoreResults', async (req, res) => {
  try {
    const activityId = safeString(req.body.activityId);
    const filters = req.body.filters || {};
    const offset = Math.max(0, Math.floor(toNumber(req.body.offset, 0)));
    const page = Math.max(1, Math.floor(toNumber(req.body.page, 1)));
    const pageSize = Math.min(100, Math.max(5, Math.floor(toNumber(req.body.pageSize, 20))));
    const nocache = req.body.nocache === true;
    const dataType = safeString(req.body.dataType) || 'overview';
    const targetId = safeString(req.body.targetId);
    const recordId = safeString(req.body.recordId);
    const departmentName = safeString(req.body.departmentName);
    const scorerKey = safeString(req.body.scorerKey);

    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_c5ed87fa11 });
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    // 活动归属必须在任何缓存读取之前验证，避免旧组织活动 ID 命中共享缓存。
    const orgId = await getCurrentOrgId();
    const scopedActivity = await activityModel.getById(activityId);
    if (!scopedActivity) return res.json(buildActivityNotFoundPayload(dataType));

    // ── Overview cache shortcut ──
    if (dataType === 'overview') {
      const cacheKey = getOverviewCacheKey(orgId, activityId, dataType, filters);
      if (nocache) await sharedCache.invalidateKey(cacheKey);
      const cached = await getCachedOverview(cacheKey);
      if (cached && cached.historicalIntegrityVerified === true) {
        return res.json({
          status: 'success',
          activity: cached.activity,
          overviewRows: cached.overviewRows,
          needsAssignmentDisambiguation: cached.needsAssignmentDisambiguation === true,
          stats: cached.stats,
          filterOptions: cached.filterOptions,
          pagination: { total: cached.overviewRows.length }
        });
      }
      if (cached) await sharedCache.invalidateKey(cacheKey);
      // Cache miss — compute via unified scoring engine (same as user-side, millisecond-fast)
      const granularity = participantService.normalizeGranularity(scopedActivity.participant_granularity);
      const [memRaw, orgLk] = await Promise.all([
        participantService.listParticipants(orgId, granularity),
        fetchOrgLookups(orgId)
      ]);

      const mems = memRaw.map((item) => normalizeMember(item, orgLk));
      const actBrief = { id: scopedActivity.id, name: safeString(scopedActivity.name), description: safeString(scopedActivity.description) };

      const { computeValidScoreMap, getHistoricalSnapshotFailure } = require('../utils/scoreCalc');
      const {
        finalScoreMap,
        submittedByTarget,
        expectedByCount,
        scorerExpectedCount,
        targetSnapshots,
        diagnostics
      } = await computeValidScoreMap(activityId, orgId, { includeCounts: true });
      const historicalFailure = getHistoricalSnapshotFailure(diagnostics);
      if (historicalFailure) {
        return res.json(Object.assign({}, historicalFailure, {
          message: historicalFailure.status === 'historical_snapshot_missing'
            ? localeCopy.historicalSnapshotMissing
            : localeCopy.historicalSnapshotInvalid
        }));
      }

      // 当前目录用于补充尚未产生评分的成员；已有历史评分必须保留提交时目标快照。
      const overviewMembers = mergeHistoricalTargets(mems, targetSnapshots);
      const overviewRows = overviewMembers.map(function (member) {
        let scoreData = finalScoreMap.get(member.id);
        let finalScore = scoreData ? scoreData.finalScore : 0;
        let expCount = expectedByCount.get(member.id) || 0;
        let sub = submittedByTarget.get(member.id) || new Set();
        let submittedCount = sub.size;
        expCount = Math.max(expCount, submittedCount);
        return {
          id: member.id, targetId: member.id,
          personId: member.personId, assignmentId: member.assignmentId,
          assignmentKind: member.assignmentKind,
          departmentId: member.departmentId, identityId: member.identityId,
          workGroupId: member.workGroupId,
          name: member.name, studentId: member.studentId,
          department: member.department, identity: member.identity,
          workGroup: member.workGroup || DEFAULT_WORK_GROUP,
          finalScore: roundScore(finalScore),
          expectedScorerCount: expCount,
          submittedScorerCount: submittedCount,
          pendingScorerCount: Math.max(expCount - submittedCount, 0),
          completionRate: expCount ? Number(((submittedCount / expCount) * 100).toFixed(2)) : 0
        };
      });
      const overviewPresentation = decorateAssignmentRows(overviewRows);

      // Apply filters
      let deptFv = safeString(filters.department);
      let identFv = safeString(filters.identity);
      let wgFv = safeString(filters.workGroup);
      let matchFv = function (row) {
        if (!isAllFilter(deptFv) && safeString(row.department) !== deptFv) return false;
        if (!isAllFilter(identFv) && safeString(row.identity) !== identFv) return false;
        if (!isAllFilter(wgFv) && safeString(row.workGroup || DEFAULT_WORK_GROUP) !== wgFv) return false;
        return true;
      };

      let filteredRows = overviewPresentation.rows.filter(matchFv);

      // Filter options
      let filterOpts = {
        departments: [...new Set(filteredRows.map(function (i) { return i.department; }).filter(Boolean))].sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); }),
        identities: [...new Set(filteredRows.map(function (i) { return i.identity; }).filter(Boolean))].sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); }),
        workGroups: [...new Set(filteredRows.map(function (i) { return i.workGroup || DEFAULT_WORK_GROUP; }).filter(Boolean))].sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); })
      };

      // Stats
      let scoredIds = new Set();
      submittedByTarget.forEach(function (scorers, tid) { if (scorers.size > 0) scoredIds.add(tid); });
      let recCount = 0;
      let midSet = new Set(overviewMembers.map(function (m) { return m.id; }));
      let memById = new Map(overviewMembers.map(function (m) { return [m.id, m]; }));
      submittedByTarget.forEach(function (scorers, tid) {
        if (!midSet.has(tid)) return;
        let tm = memById.get(tid);
        if (tm && matchFv({ department: tm.department, identity: tm.identity, workGroup: tm.workGroup || DEFAULT_WORK_GROUP })) {
          recCount += scorers.size;
        }
      });

      // Compute completedMembers (scorers who finished all expected tasks)
      let scorerSub = new Map();
      submittedByTarget.forEach(function (scorers) {
        scorers.forEach(function (sk) { scorerSub.set(sk, (scorerSub.get(sk) || 0) + 1); });
      });
      let completed = 0;
      scorerExpectedCount.forEach(function (expCount, sk) {
        if ((scorerSub.get(sk) || 0) >= expCount) completed++;
      });

      let overviewStats = {
        totalMembers: filteredRows.length,
        scoredMembers: filteredRows.filter(function (r) { return scoredIds.has(safeString(r.targetId || r.id)); }).length,
        recordCount: recCount,
        completedMembers: completed
      };

      // Cache and return
      await setCachedOverview(cacheKey, {
        historicalIntegrityVerified: true,
        overviewRows: filteredRows,
        needsAssignmentDisambiguation: overviewPresentation.needsAssignmentDisambiguation,
        stats: overviewStats,
        filterOptions: filterOpts,
        activity: actBrief
      });

      return res.json({
        status: 'success',
        activity: actBrief,
        overviewRows: filteredRows,
        needsAssignmentDisambiguation: overviewPresentation.needsAssignmentDisambiguation,
        stats: overviewStats,
        filterOptions: filterOpts,
        pagination: { total: filteredRows.length }
      });
    }

    // ── Non-overview dataTypes: load full data ──
    const granularity = participantService.normalizeGranularity(scopedActivity.participant_granularity);
    const [membersRaw, recordsRaw, orgLookups] = await Promise.all([
      participantService.listParticipants(orgId, granularity),
      scoreRecordModel.getByActivity(activityId),
      fetchOrgLookups(orgId)
    ]);

    const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
    const recordsWithAnswers = await enrichRecordsWithAnswers(recordsRaw);
    const enrichedRecords = enrichScoreRecords(recordsWithAnswers, members, granularity);
    const inspection = inspectImmutableRecords(enrichedRecords, activityId);
    const historicalFailure = getHistoricalSnapshotFailure(inspection.diagnostics);
    if (historicalFailure) {
      return res.json(Object.assign({}, historicalFailure, {
        message: historicalFailure.status === 'historical_snapshot_missing'
          ? localeCopy.historicalSnapshotMissing
          : localeCopy.historicalSnapshotInvalid
      }));
    }
    const records = inspection.records;
    const activityBrief = { id: scopedActivity.id, name: safeString(scopedActivity.name), description: safeString(scopedActivity.description) };
    const taskData = buildImmutableTaskData(records);
    const completionData = taskData;
    const resolveScorerKey = (record) => safeString(
      record && record.calculationSnapshot && record.calculationSnapshot.scorer.participantId
    );
    const memberByScorerKey = new Map(taskData.scorerTaskRows.map((row) => [safeString(row.scorerKey), row]));

    // pairTaskByKey: "ruleId::targetId::scorerKey" → expectedPair (replaces findExpectedPairTask)
    let pairTaskByKey = new Map();
    if (taskData.expectedPairs) {
      taskData.expectedPairs.forEach(function (task) {
        pairTaskByKey.set(task.targetId + '::' + task.scorerKey, task);
      });
    }

    // ── Inline findExpectedPairTask (O(1) Map lookup) ──
    function lookupExpectedTask(record, scorerKey) {
      let tId = safeString(record.targetId);
      return pairTaskByKey.get(tId + '::' + scorerKey) || null;
    }

    // ── Unified activity-level stats (same meaning across all dataType views) ──
    const excludedRecordIds = taskData.excludedRecordIds;
    const scoredTargetIds = new Set();
    records.forEach((record) => {
      if (!excludedRecordIds.has(safeString(record.id))) scoredTargetIds.add(safeString(record.targetId));
    });
    const baseStats = {
      totalMembers: members.length,
      scoredMembers: members.filter((m) => scoredTargetIds.has(safeString(m.id))).length,
      recordCount: records.length,
      completedMembers: taskData.scorerTaskRows.filter((s) => toNumber(s.pendingCount, 0) === 0).length
    };

    if (dataType === 'scorerTargets') {
      if (!scorerKey) return res.json({ status: 'invalid_params', message: localeCopy.copy_66565f7cf6 });
      const expectedTargets = new Map();
      (taskData.expectedPairs || []).forEach((pair) => {
        if (pair.scorerKey !== scorerKey) return;
        if (!expectedTargets.has(pair.targetId)) expectedTargets.set(pair.targetId, {
          targetId: pair.targetId, targetName: pair.targetName, targetStudentId: pair.targetStudentId,
          targetDepartment: pair.targetDepartment, targetIdentity: pair.targetIdentity,
          targetWorkGroup: pair.targetWorkGroup || DEFAULT_WORK_GROUP
        });
      });
      const submittedRecordMap = new Map();
      records.forEach((record) => {
        const recordScorerKey = resolveScorerKey(record);
        if (recordScorerKey !== scorerKey) return;
        const tid = safeString(record.targetId);
        if (expectedTargets.has(tid) && !submittedRecordMap.has(tid)) {
          submittedRecordMap.set(tid, safeString(record.id));
        }
      });
      const scorerMember = memberByScorerKey.get(scorerKey) || {};
      const scorerTargetRows = Array.from(expectedTargets.values()).map((target) => {
        const isSubmitted = submittedRecordMap.has(target.targetId);
        return {
          targetId: target.targetId, targetName: target.targetName, targetStudentId: target.targetStudentId,
          targetDepartment: target.targetDepartment, targetIdentity: target.targetIdentity,
          targetWorkGroup: target.targetWorkGroup,
          status: isSubmitted ? 'submitted' : 'pending',
          statusText: isSubmitted ? localeCopy.copy_0274004bba : localeCopy.copy_6efdc6ebba,
          statusClass: isSubmitted ? 'status-completed' : 'status-pending',
          recordId: isSubmitted ? (submittedRecordMap.get(target.targetId) || '') : ''
        };
      }).sort((a, b) => {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        return String(a.targetName).localeCompare(String(b.targetName), 'zh-CN');
      });
      return res.json({ status: 'success', activity: activityBrief, scorerName: scorerMember ? scorerMember.name : scorerKey, scorerTargetRows });
    }

    if (dataType === 'recordDetail') {
      if (!recordId) return res.json({ status: 'invalid_params', message: localeCopy.copy_52a76c0da1 });
      const recordById = new Map(records.map((r) => [safeString(r.id), r]));
      const record = recordById.get(safeString(recordId));
      if (!record) return res.json({ status: 'not_found', message: localeCopy.copy_c173b07ef3 });
      const templates = getRecordTemplateScores(record).map((template) => ({
        ...template,
        templateName: safeString(template.templateName),
        weightedScore: template.score * template.weight
      }));
      // Build answer map keyed by global questionIndex (handles legacy 0-based data)
      const ansArr = Array.isArray(record.answers) ? record.answers : [];
      const answerMap = new Map(ansArr.map((item, idx) => {
        const raw = item.questionIndex != null ? item.questionIndex : idx;
        const hasZero = ansArr.some(a => a.questionIndex === 0);
        const key = hasZero ? raw + 1 : raw;
        return [String(key), toNumber(item.score, 0)];
      }));
      let questionCursor = 0;
      const answerGroups = templates.map((tpl) => {
        const tplQuestions = tpl.questions || [];
        const questions = tplQuestions.map((q, qi) => {
          const globalIdx = questionCursor + qi + 1;
          const score = toNumber(answerMap.get(String(globalIdx)), 0);
          return {
            questionIndex: qi + 1, question: safeString(q.question),
            scoreLabel: safeString(q.scoreLabel),
            minValue: toNumber(q.minValue, 0), maxValue: toNumber(q.maxValue, 0),
            stepValue: toNumber(q.stepValue, 0), score
          };
        });
        questionCursor += tplQuestions.length;
        return {
          templateId: tpl.templateId, templateName: tpl.templateName,
          weight: tpl.weight, score: roundScore(tpl.score),
          weightedScore: roundScore(tpl.weightedScore), questions
        };
      });
      return res.json({
        status: 'success',
        recordDetail: {
          recordId: safeString(record.id),
          scorer: { id: safeString(record.scorerId), name: safeString(record.scorerName), studentId: safeString(record.scorerStudentId), identity: safeString(record.scorerIdentity) },
          target: { id: safeString(record.targetId), name: safeString(record.targetName), studentId: safeString(record.targetStudentId), identity: safeString(record.targetIdentity) },
          submittedAt: record.submittedAt || null,
          templates: answerGroups,
          rawAnswers: ansArr.map((item, index) => ({
            questionIndex: item.questionIndex != null ? item.questionIndex : index + 1,
            score: toNumber(item.score, 0)
          })),
          historicalRuleUnavailable: false,
          immutableSnapshot: true
        }
      });
    }

    if (dataType === 'completion') {
      // Use completionData.scorerTaskRows directly (already pre-mapped member→row, no .find() needed)
      const scorerPresentation = decorateAssignmentRows(completionData.scorerTaskRows);
      const allScorerRows = scorerPresentation.rows;
      const filteredRows = filterScorerRows(allScorerRows, filters);

      // Filter-aware stats (same dimension logic as overview: scoredMembers/recordCount by TARGET,
      // completedMembers by SCORER attributes)
      const deptF = safeString(filters.department);
      const identF = safeString(filters.identity);
      const wgF = safeString(filters.workGroup);
      const stats = {
        totalMembers: filteredRows.length,
        scoredMembers: members.filter((m) => scoredTargetIds.has(safeString(m.id)) &&
          (isAllFilter(deptF) || safeString(m.department) === deptF) &&
          (isAllFilter(identF) || safeString(m.identity) === identF) &&
          (isAllFilter(wgF) || safeString(m.workGroup || DEFAULT_WORK_GROUP) === wgF)
        ).length,
        recordCount: records.filter((r) =>
          (isAllFilter(deptF) || safeString(r.targetDepartment) === deptF) &&
          (isAllFilter(identF) || safeString(r.targetIdentity) === identF) &&
          (isAllFilter(wgF) || safeString(r.targetWorkGroup || DEFAULT_WORK_GROUP) === wgF)
        ).length,
        completedMembers: completionData.scorerTaskRows.filter((s) =>
          (isAllFilter(deptF) || safeString(s.department) === deptF) &&
          (isAllFilter(identF) || safeString(s.identity) === identF) &&
          (isAllFilter(wgF) || safeString(s.workGroup || DEFAULT_WORK_GROUP) === wgF)
        ).filter((s) => toNumber(s.pendingCount, 0) === 0).length
      };

      const filterOptions = {
        departments: [...new Set(filteredRows.map((i) => i.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
        identities: [...new Set(filteredRows.map((i) => i.identity).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
        workGroups: [...new Set(filteredRows.map((i) => i.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
      };
      if (departmentName) {
        const deptRows = filteredRows.filter((r) => safeString(r.department) === departmentName).sort((a, b) => { if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount; return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN'); });
        return res.json({
          status: 'success', activity: activityBrief, scorerCompletionRows: deptRows, stats, filterOptions,
          needsAssignmentDisambiguation: scorerPresentation.needsAssignmentDisambiguation
        });
      }
      return res.json({
        status: 'success', activity: activityBrief,
        scorerCompletionRows: filteredRows,
        needsAssignmentDisambiguation: scorerPresentation.needsAssignmentDisambiguation,
        completionBoards: { departments: buildCompletionBoard(filteredRows, 'department', true) },
        stats,
        filterOptions
      });
    }

    if (dataType === 'targetRecords') {
      if (!targetId) return res.json({ status: 'invalid_params', message: localeCopy.copy_aa47fc241f });
      const targetRecords = records.filter((r) => safeString(r.targetId) === safeString(targetId));
      const expectRow = {
        targetId,
        expectedScorers: taskData.expectedPairs.filter((pair) => safeString(pair.targetId) === safeString(targetId))
      };

      const recordRows = targetRecords.map((record) => {
        const rsk = resolveScorerKey(record);
        const task = lookupExpectedTask(record, rsk);
        const sk = safeString((task && task.scorerKey) || rsk || record.scorerId);
        return {
          recordId: safeString(record.id), activityId, activityName: activityBrief.name,
          scorerKey: sk, scorerId: safeString(record.scorerId), scorerName: safeString(record.scorerName),
          scorerStudentId: safeString(record.scorerStudentId), scorerDepartment: safeString(record.scorerDepartment),
          scorerIdentity: safeString(record.scorerIdentityCategory || record.scorerIdentity),
          scorerWorkGroup: safeString(record.scorerWorkGroup),
          scorerAssignmentLabel: safeString(record.scorerAssignmentLabel),
          scorerHistoricalAssignmentUnavailable: record.scorerHistoricalAssignmentUnavailable === true,
          scorerCategoryLabel: record.scorerHistoricalAssignmentUnavailable
            ? ''
            : ([safeString(record.scorerDepartment), safeString(record.scorerIdentityCategory || record.scorerIdentity)].filter(Boolean).join(' / ') || localeCopy.copy_4c1e73aff1),
          targetId: safeString(record.targetId), submittedAt: record.submittedAt || null,
          excludedByRequireAll: excludedRecordIds.has(safeString(record.id))
        };
      });

      const targetRecordRows = [];
      const recordMapByKey = new Map();
      recordRows.forEach((r) => { recordMapByKey.set(r.scorerKey, r); });
      const expectedByKey = new Map();
      expectRow.expectedScorers.forEach((t) => { if (!expectedByKey.has(t.scorerKey)) expectedByKey.set(t.scorerKey, t); });
      expectedByKey.forEach((task, sk) => {
        const rec = recordMapByKey.get(sk);
        targetRecordRows.push(rec ? {
          ...rec,
          status: rec.excludedByRequireAll ? 'inactive' : 'completed',
          statusText: rec.excludedByRequireAll ? scoringCopy.statusInactive : scoringCopy.statusCompleted
        } : { recordId: '', targetId, scorerKey: sk, scorerId: safeString(task.scorerId), scorerName: safeString(task.scorerName), scorerStudentId: safeString(task.scorerStudentId), scorerDepartment: safeString(task.scorerDepartment), scorerIdentity: safeString(task.scorerIdentity), scorerWorkGroup: safeString(task.scorerWorkGroup), status: 'pending', statusText: localeCopy.copy_8d112a0e5f, submittedAt: '', excludedByRequireAll: false });
      });
      // 当前规则变化或审批人离任后，已发生的评分事实仍须出现在历史中。
      recordMapByKey.forEach((recordRow, sk) => {
        if (expectedByKey.has(sk)) return;
        targetRecordRows.push({
          ...recordRow,
          status: 'completed',
          statusText: scoringCopy.statusCompleted,
          historicalOnly: true
        });
      });

      res.json({
        status: 'success', activity: activityBrief, targetRecordRows,
        stats: { recordCount: targetRecordRows.length },
        pagination: { offset, nextOffset: targetRecordRows.length, total: targetRecordRows.length, hasMore: false, returnedCount: targetRecordRows.length }
      });
      return;
    }

    // Standard data types: overview, calculation, detail, records
    const hrMap = new Map(members.map((item) => [item.id, item]));
    const needsRecords = dataType === 'records';
    const needsDetail = dataType === 'detail';
    const needsCalculation = dataType === 'calculation' || dataType === 'overview';

    const calculationMap = new Map();
    const detailRows = [];
    const recordRows = [];

    records.forEach((record) => {
      const targetBase = {
        targetId: safeString(record.targetId), assignmentId: safeString(record.targetAssignmentId),
        personId: safeString(record.targetPersonId), assignmentNature: safeString(record.targetAssignmentNature),
        assignmentLabel: safeString(record.targetAssignmentLabel),
        historicalAssignmentUnavailable: record.targetHistoricalAssignmentUnavailable === true,
        departmentId: safeString(record.targetDepartmentId),
        identityCategoryId: safeString(record.targetIdentityCategoryId || record.targetIdentityId),
        identityId: safeString(record.targetIdentityCategoryId || record.targetIdentityId),
        workGroupId: safeString(record.targetWorkGroupId),
        name: safeString(record.targetName), studentId: safeString(record.targetStudentId),
        department: safeString(record.targetDepartment),
        identityCategory: safeString(record.targetIdentityCategory || record.targetIdentity),
        identity: safeString(record.targetIdentityCategory || record.targetIdentity),
        workGroup: record.targetHistoricalAssignmentUnavailable ? '' : safeString(record.targetWorkGroup || DEFAULT_WORK_GROUP)
      };

      // 历史记录只使用写入时的岗位快照和原规则引用，调岗、离任或字典改名
      // 都不得重写或隐藏已经发生的评分事实。
      const scorerDepartmentId = safeString(record.scorerDepartmentId);
      const scorerIdentityId = safeString(record.scorerIdentityId);
      const scorerCategoryKey = `${scorerDepartmentId}::${scorerIdentityId}`;
      const historicalRuleUnavailable = false;
      const sigStale = false;

      const scorerDepartment = safeString(record.scorerDepartment);
      const scorerIdentity = safeString(record.scorerIdentityCategory || record.scorerIdentity);
      const scorerCategoryLabel = record.scorerHistoricalAssignmentUnavailable
        ? ''
        : ([scorerDepartment, scorerIdentity].filter(Boolean).join(' / ') || localeCopy.copy_4c1e73aff1);
      const scorerHistoricalFields = {
        scorerAssignmentLabel: safeString(record.scorerAssignmentLabel),
        scorerHistoricalAssignmentUnavailable: record.scorerHistoricalAssignmentUnavailable === true
      };
      const rsk = resolveScorerKey(record);
      const expectedTask = lookupExpectedTask(record, rsk);
      const sk = safeString((expectedTask && expectedTask.scorerKey) || rsk || record.scorerId);
      const excludedByRequireAll = excludedRecordIds.has(safeString(record.id));

      if (needsRecords) {
        const tplScores = getRecordTemplateScores(record);
        const tplSummary = tplScores.map((item) => (
          `${safeString(item.templateName)} × ${toNumber(item.weight, 0)}`
        )).filter(Boolean).join('；');
        recordRows.push({ recordId: safeString(record.id), activityId, activityName: activityBrief.name, scorerKey: sk, scorerId: safeString(record.scorerId), scorerName: safeString(record.scorerName), scorerStudentId: safeString(record.scorerStudentId), scorerDepartment, scorerIdentity, scorerWorkGroup: safeString(record.scorerWorkGroup || ''), scorerCategoryLabel, ...scorerHistoricalFields, ...targetBase, templateSummary: tplSummary, submittedAt: record.submittedAt || null, excludedByRequireAll, signatureStale: false, historicalRuleUnavailable });
        return;
      }

      const tplScores = getRecordTemplateScores(record);
      if (needsDetail && !tplScores.length) {
        detailRows.push({
          ...targetBase,
          scorerId: safeString(record.scorerId),
          scorerName: safeString(record.scorerName),
          scorerStudentId: safeString(record.scorerStudentId),
          scorerDepartment,
          scorerIdentity,
          scorerCategoryLabel,
          ...scorerHistoricalFields,
          ruleId: safeString(record.ruleId),
          recordId: safeString(record.id),
          templateId: '',
          templateName: '',
          weight: null,
          templateScore: null,
          weightedScore: null,
          submittedAt: record.submittedAt || null,
          excludedByRequireAll,
          signatureStale: true,
          historicalRuleUnavailable: true
        });
      }
      tplScores.forEach((tplItem) => {
        const cfg = tplItem;
        const tplName = safeString(tplItem.templateName);
        const weight = toNumber(tplItem.weight, 0);
        const tplScore = toNumber(tplItem.score, 0);

        if (needsCalculation) {
          const gKey = [
            targetBase.targetId,
            scorerCategoryKey,
            tplItem.templateId,
            buildAggregationPolicySignature(record.calculationSnapshot)
          ].join('||');
          if (!calculationMap.has(gKey)) {
            const calcMethod = safeString(cfg.calculationMethod || cfg.calculation_method) || 'weighted_average';
            const trimH = Number(cfg.trimHighCount || cfg.trim_high_count || 0);
            const trimL = Number(cfg.trimLowCount || cfg.trim_low_count || 0);
            calculationMap.set(gKey, { ...targetBase, scorerDepartment, scorerIdentity, scorerCategoryKey, scorerCategoryLabel, ...scorerHistoricalFields, templateId: tplItem.templateId, templateName: tplName, weight, method: calcMethod, trimHigh: trimH, trimLow: trimL, scores: [] });
          }
          if (!excludedByRequireAll) { calculationMap.get(gKey).scores.push(tplScore); }
        }

        if (needsDetail) {
          detailRows.push({ ...targetBase, scorerId: safeString(record.scorerId), scorerName: safeString(record.scorerName), scorerStudentId: safeString(record.scorerStudentId), scorerDepartment, scorerIdentity, scorerCategoryLabel, ...scorerHistoricalFields, ruleId: safeString(record.ruleId), recordId: safeString(record.id), templateId: tplItem.templateId, templateName: tplName, weight, templateScore: tplScore, weightedScore: roundScore(tplScore * weight), submittedAt: record.submittedAt || null, excludedByRequireAll, signatureStale, historicalRuleUnavailable });
        }
      });
    });


    const calculationRows = needsCalculation
      ? Array.from(calculationMap.values()).filter((item) => item.scores.length > 0).map((item) => {
          const result = applyCalcMethod(item.scores, item.weight, item.method, item.trimHigh, item.trimLow);
          return { ...item, recordCount: item.scores.length, sumScore: item.scores.reduce(function(s, v) { return s + v; }, 0), ...result };
        })
      : [];

    let sourceForFilters = needsRecords ? recordRows : needsDetail ? detailRows : calculationRows;
    const targetPresentation = decorateAssignmentRows(sourceForFilters);
    sourceForFilters = targetPresentation.rows;

    // Use unified activity-level stats computed before dataType branches
    const scoredMembers = baseStats.scoredMembers;
    const recordCount = baseStats.recordCount;
    const completedMembers = baseStats.completedMembers;

    // Build response
    const buildFilterOptions = (rows) => ({
      departments: [...new Set(rows.map((i) => i.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      identities: [...new Set(rows.map((i) => i.identity).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      workGroups: [...new Set(rows.map((i) => i.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    });

    const deptF = safeString(filters.department);
    const identF = safeString(filters.identity);
    const wgF = safeString(filters.workGroup);
    const matchFilter = (row) => {
      if (!isAllFilter(deptF) && safeString(row.department) !== deptF) return false;
      if (!isAllFilter(identF) && safeString(row.identity) !== identF) return false;
      if (!isAllFilter(wgF) && safeString(row.workGroup || DEFAULT_WORK_GROUP) !== wgF) return false;
      return true;
    };

    const sourceRows = sourceForFilters.filter(matchFilter);
    const filterOptions = buildFilterOptions(sourceRows);

    // ── Non-overview dataTypes: use existing size‑based slicing (backward compatible) ──
    const basePayload = { status: 'success', activity: activityBrief, overviewRows: [], calculationRows, detailRows: needsDetail ? detailRows : [], recordRows: needsRecords ? recordRows : [], scorerCompletionRows: [], scorerTaskRows: taskData.scorerTaskRows, needsAssignmentDisambiguation: targetPresentation.needsAssignmentDisambiguation, completionBoards: { departments: [] }, stats: { totalMembers: sourceRows.length, scoredMembers, recordCount, calculationItemCount: needsCalculation ? calculationRows.length : 0, completedMembers }, filterOptions, pagination: { offset, nextOffset: offset, total: 0, hasMore: false, returnedCount: 0 } };

    const filteredPayload = { ...basePayload };
    const rowField = needsRecords ? 'recordRows' : needsDetail ? 'detailRows' : needsCalculation ? 'calculationRows' : 'overviewRows';
    filteredPayload[rowField] = [];
    if (dataType !== 'detail') filteredPayload.detailRows = [];
    if (dataType !== 'records') filteredPayload.recordRows = [];
    if (dataType !== 'calculation') filteredPayload.calculationRows = [];

    const pageResult = sliceRowsBySize(sourceRows, offset, filteredPayload, rowField);
    filteredPayload[rowField] = pageResult.rows;
    filteredPayload.pagination = { offset, nextOffset: pageResult.nextOffset, total: sourceRows.length, hasMore: pageResult.hasMore, returnedCount: pageResult.rows.length };
    filteredPayload.stats.totalMembers = sourceRows.length;
    // Recompute stats after filtering to respect department/identity/workGroup view
    filteredPayload.stats.scoredMembers = new Set(
      sourceRows.map((r) => safeString(r.targetId || r.id)).filter((tid) => scoredTargetIds.has(tid))
    ).size;
    filteredPayload.stats.recordCount = records.filter((r) => {
      if (!isAllFilter(deptF) && safeString(r.targetDepartment) !== deptF) return false;
      if (!isAllFilter(identF) && safeString(r.targetIdentity) !== identF) return false;
      if (!isAllFilter(wgF) && safeString(r.targetWorkGroup || DEFAULT_WORK_GROUP) !== wgF) return false;
      return true;
    }).length;
    filteredPayload.stats.completedMembers = taskData.scorerTaskRows.filter((s) => {
      if (!isAllFilter(deptF) && safeString(s.department) !== deptF) return false;
      if (!isAllFilter(identF) && safeString(s.identity) !== identF) return false;
      if (!isAllFilter(wgF) && safeString(s.workGroup || DEFAULT_WORK_GROUP) !== wgF) return false;
      return true;
    }).filter((s) => toNumber(s.pendingCount, 0) === 0).length;

    res.json(filteredPayload);
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) || localeCopy.copy_c59ab1ce4a });
  }
});

function buildCompletionBoard(rows, field, lean) {
  const boardMap = new Map();
  rows.filter((item) => Number(item.expectedCount || 0) > 0).forEach((item) => {
    const key = safeString(item[field]) || localeCopy.copy_2b4df49497;
    if (!boardMap.has(key)) boardMap.set(key, { groupName: key, memberCount: 0, completedCount: 0, pendingCount: 0, expectedTotal: 0, submittedTotal: 0, scorerRows: lean ? undefined : [] });
    const board = boardMap.get(key);
    const exp = toNumber(item.expectedCount, 0); const sub = toNumber(item.submittedCount, 0);
    board.memberCount += 1; board.completedCount += sub >= exp ? 1 : 0; board.pendingCount += sub >= exp ? 0 : 1;
    board.expectedTotal += exp; board.submittedTotal += sub;
    if (!lean) board.scorerRows.push({ ...item, pendingCount: Math.max(exp - sub, 0), completionRate: exp ? Number(((sub / exp) * 100).toFixed(2)) : 100 });
  });
  return Array.from(boardMap.values()).map((item) => ({ ...item, completionRate: item.memberCount ? Number(((item.completedCount / item.memberCount) * 100).toFixed(2)) : 100 })).sort((a, b) => String(a.groupName || '').localeCompare(String(b.groupName || ''), 'zh-CN'));
}

// exportScoreResults
router.post('/exportScoreResults', async (req, res) => {
  try {
    const activityId = safeString(req.body.activityId);
    const reportType = safeString(req.body.reportType) || 'completion';
    const format = safeString(req.body.format) || 'csv';
    const filters = req.body.filters || {};

    if (!activityId) return res.json({ status: 'invalid_params', message: localeCopy.copy_c5ed87fa11 });
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const activity = await activityModel.getById(activityId);
    if (!activity) return res.json({ status: 'activity_not_found', message: localeCopy.copy_939db6a08b });
    const orgId = await getCurrentOrgId();
    const granularity = participantService.normalizeGranularity(activity.participant_granularity);
    const [membersRaw, recordsRaw, orgLookups] = await Promise.all([
      participantService.listParticipants(orgId, granularity),
      scoreRecordModel.getByActivity(activityId),
      fetchOrgLookups()
    ]);

    const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
    const recordsWithAnswers = await enrichRecordsWithAnswers(recordsRaw);
    const enrichedRecords = enrichScoreRecords(recordsWithAnswers, members, granularity);
    const inspection = inspectImmutableRecords(enrichedRecords, activityId);
    const exportHistoricalFailure = getHistoricalSnapshotFailure(inspection.diagnostics);
    if (exportHistoricalFailure) {
      return res.json(Object.assign({}, exportHistoricalFailure, {
        message: exportHistoricalFailure.status === 'historical_snapshot_missing'
          ? localeCopy.historicalSnapshotMissing
          : localeCopy.historicalSnapshotInvalid
      }));
    }
    const records = inspection.records;
    const taskData = buildImmutableTaskData(records);
    const activityName = safeString(activity.name);

    let rows = []; let headers = []; let fileName = activityName;

    if (reportType === 'overview') {
      // Use unified scoring engine (same as getScoreResults overview)
      const { computeValidScoreMap, getHistoricalSnapshotFailure } = require('../utils/scoreCalc');
      const {
        finalScoreMap,
        submittedByTarget,
        expectedByCount,
        targetSnapshots,
        diagnostics
      } = await computeValidScoreMap(activityId, orgId, { includeCounts: true });
      const historicalFailure = getHistoricalSnapshotFailure(diagnostics);
      if (historicalFailure) {
        return res.json(Object.assign({}, historicalFailure, {
          message: historicalFailure.status === 'historical_snapshot_missing'
            ? localeCopy.historicalSnapshotMissing
            : localeCopy.historicalSnapshotInvalid
        }));
      }

      rows = mergeHistoricalTargets(members, targetSnapshots).map(function (m) {
        let scoreData = finalScoreMap.get(m.id);
        let finalScore = scoreData ? scoreData.finalScore : 0;
        let expCount = expectedByCount.get(m.id) || 0;
        let sub = submittedByTarget.get(m.id) || new Set();
        expCount = Math.max(expCount, sub.size);
        return {
          name: m.name, studentId: m.studentId, department: m.department,
          identity: m.identity, workGroup: m.workGroup || '',
          finalScore: roundScore(finalScore),
          expectedScorerCount: expCount, submittedScorerCount: sub.size,
          completionRate: expCount ? Number(((sub.size / expCount) * 100).toFixed(2)) : 0
        };
      });
      fileName = activityName + localeCopy.copy_3747a7097d;
      headers = [{ key: 'name', label: localeCopy.copy_3c946202ff }, { key: 'studentId', label: localeCopy.copy_cbb853db1b }, { key: 'department', label: localeCopy.copy_bc011e4e3b }, { key: 'identity', label: localeCopy.copy_474f638a6f }, { key: 'workGroup', label: localeCopy.copy_be736f763d }, { key: 'finalScore', label: localeCopy.copy_80528cd2d0 }, { key: 'submittedScorerCount', label: localeCopy.copy_b07e7eb09d }, { key: 'expectedScorerCount', label: localeCopy.copy_02b5a88c0f }, { key: 'completionRate', label: localeCopy.copy_cc6cc6ec7f }];
    } else if (reportType === 'detail') {
      headers = [{ key: 'scorerName', label: localeCopy.copy_b74f5017ad }, { key: 'scorerStudentId', label: localeCopy.copy_1a9dbccd72 }, { key: 'scorerDepartment', label: localeCopy.copy_1b48da3bfa }, { key: 'scorerIdentity', label: localeCopy.copy_98dbb06c03 }, { key: 'scorerWorkGroup', label: localeCopy.copy_92042b74b7 }, { key: 'targetName', label: localeCopy.copy_de4dcf6fb4 }, { key: 'targetStudentId', label: localeCopy.copy_ba70cb6582 }, { key: 'targetDepartment', label: localeCopy.copy_155d45cc30 }, { key: 'targetIdentity', label: localeCopy.copy_f15fa8cc75 }, { key: 'targetWorkGroup', label: localeCopy.copy_c5cab60297 }, { key: 'templateName', label: localeCopy.copy_fac1711a09 }, { key: 'question', label: localeCopy.copy_b66cf0dd1d }, { key: 'score', label: localeCopy.copy_011a01321b }, { key: 'maxValue', label: localeCopy.copy_8ca6566932 }, { key: 'weight', label: localeCopy.copy_e3cee0beef }, { key: 'submittedAt', label: localeCopy.copy_6a2da85cb7 }];
      records.forEach((record) => {
        const answers = record.answers || [];
        const answerMap = new Map();
        answers.forEach((a, ai) => {
          const raw = a.questionIndex != null ? a.questionIndex : ai;
          const hasZero = answers.some(aa => aa.questionIndex === 0);
          answerMap.set(String(hasZero ? raw + 1 : raw), toNumber(a.score, 0));
        });
        const templates = getRecordTemplateScores(record);
        let appended = false;
        templates.forEach((template) => {
          template.questions.forEach((question) => {
            appended = true;
            rows.push({
              scorerName: safeString(record.scorerName), scorerStudentId: safeString(record.scorerStudentId),
              scorerDepartment: safeString(record.scorerDepartment), scorerIdentity: safeString(record.scorerIdentity),
              scorerWorkGroup: safeString(record.scorerWorkGroup || ''),
              targetName: safeString(record.targetName), targetStudentId: safeString(record.targetStudentId),
              targetDepartment: safeString(record.targetDepartment), targetIdentity: safeString(record.targetIdentity),
              targetWorkGroup: safeString(record.targetWorkGroup || ''),
              templateName: safeString(template.templateName),
              question: safeString(question.question),
              score: toNumber(answerMap.get(String(question.globalQuestionIndex)), 0),
              maxValue: toNumber(question.maxValue, 0),
              weight: toNumber(template.weight, 0),
              submittedAt: record.submittedAt || null
            });
          });
        });
        if (!appended) {
          rows.push({
            scorerName: safeString(record.scorerName), scorerStudentId: safeString(record.scorerStudentId),
            scorerDepartment: safeString(record.scorerDepartment), scorerIdentity: safeString(record.scorerIdentity),
            scorerWorkGroup: safeString(record.scorerWorkGroup || ''),
            targetName: safeString(record.targetName), targetStudentId: safeString(record.targetStudentId),
            targetDepartment: safeString(record.targetDepartment), targetIdentity: safeString(record.targetIdentity),
            targetWorkGroup: safeString(record.targetWorkGroup || ''),
            templateName: '', question: '', score: '', maxValue: '', weight: '',
            submittedAt: record.submittedAt || null
          });
        }
      });
      fileName = `${activityName}_${scoringCopy.exportScoreDetail}`;
    } else {
      rows = taskData.scorerTaskRows;
      fileName = `${activityName}_${scoringCopy.exportScorerCompletion}`;
      headers = [{ key: 'scorerName', label: localeCopy.copy_b74f5017ad }, { key: 'scorerStudentId', label: localeCopy.copy_1a9dbccd72 }, { key: 'department', label: localeCopy.copy_62f8e70200 }, { key: 'identity', label: localeCopy.copy_474f638a6f }, { key: 'workGroup', label: localeCopy.copy_be736f763d }, { key: 'expectedCount', label: localeCopy.copy_6c33883f9b }, { key: 'submittedCount', label: localeCopy.copy_4430825ac4 }, { key: 'pendingCount', label: localeCopy.copy_4e5e7abce7 }, { key: 'completionRate', label: localeCopy.copy_cc6cc6ec7f }];
    }

    // Apply filters
    let filteredRows = rows;
    if (reportType === 'overview') filteredRows = filterOverviewRows(rows, filters);
    else if (reportType === 'detail') filteredRows = filterDetailRows(rows, filters);
    else if (reportType === 'completion') filteredRows = filterScorerRows(rows, filters);

    // Safety cap: refuse exports larger than EXPORT_MAX_ROWS to prevent OOM
    if (filteredRows.length > EXPORT_MAX_ROWS) {
      return res.json({
        status: 'too_large',
        message: localeFormat(localeCopy.copy_985bc885b8, [filteredRows.length]),
        rowCount: filteredRows.length,
        maxAllowed: EXPORT_MAX_ROWS
      });
    }

    // All exports produce XLSX — wx.openDocument only supports Excel formats for save-to-path
    const sheetNames = {
      overview: scoringCopy.exportScoreOverview,
      detail: scoringCopy.exportScoreDetail,
      completion: scoringCopy.exportScorerCompletion
    };
    const fileContent = await buildXlsxBase64(sheetNames[reportType] || localeCopy.copy_47aa0b0bde, headers, filteredRows);
    const extension = 'xlsx';

    res.json({ status: 'success', fileContent, fileName, extension });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

// revokeScoreRecord
router.post('/revokeScoreRecord', async (req, res) => {
  try {
    const admin = await ensureAdmin(req);
    if (!admin) return res.json({ status: 'forbidden', message: localeCopy.copy_f048be09ae });

    const recordId = safeString(req.body.recordId);
    if (!recordId) return res.json({ status: 'invalid_params', message: localeCopy.copy_397b800fc5 });

    const record = await scoreRecordModel.getById(recordId);
    if (!record) return res.json({ status: 'not_found', message: localeCopy.copy_62fff082e2 });

    // Delete answers and record atomically within a transaction
    const { withTransaction } = require('../../../config/db');
    const { getCurrentOrgId } = require('../../../utils/orgContext');
    const orgId = await getCurrentOrgId();
    await withTransaction(async (conn) => {
      await conn.query('DELETE FROM score_answers WHERE record_id = ? AND org_id = ?', [recordId, orgId]);
      await conn.query('DELETE FROM score_records WHERE id = ? AND org_id = ?', [recordId, orgId]);
    });

    const pubCache = require('../utils/pubCache');
    await Promise.all([
      pubCache.invalidate(record.activity_id, orgId),
      sharedCache.invalidatePrefix('overview_' + orgId + '_' + record.activity_id + '_')
    ]);

    res.json({ status: 'success', message: localeCopy.copy_d08849e510 });
  } catch (e) {
    res.json({ status: 'error', message: safeString(e.message) });
  }
});

module.exports = router;
