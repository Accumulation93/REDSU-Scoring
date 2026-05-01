const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 100;

const DEFAULT_WORK_GROUP = '';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

const MAX_PARALLEL_PAGES = 20;

async function getAllRecords(query) {
  const countRes = await query.count().catch(() => ({ total: 0 }));
  const total = countRes.total || 0;
  if (total === 0) return [];

  const pageSize = 100;
  const totalPages = Math.min(Math.ceil(total / pageSize), MAX_PARALLEL_PAGES);
  const promises = [];
  for (let i = 0; i < totalPages; i++) {
    promises.push(
      query.skip(i * pageSize).limit(pageSize).get().catch((error) => {
        const message = safeString(error && (error.message || error.errMsg));
        if (message.includes('DATABASE_COLLECTION_NOT_EXIST') || message.includes('collection not exists')) {
          return { data: [] };
        }
        throw error;
      })
    );
  }
  const results = await Promise.all(promises);
  return results.flatMap((res) => res.data || []);
}

function buildOrgMap(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const id = safeString(row && row._id);
    if (!id) return;
    map.set(id, {
      id,
      name: safeString(row.name)
    });
  });
  return map;
}

async function fetchOrgLookups() {
  const [departments, identities, workGroups, templates] = await Promise.all([
    getAllRecords(db.collection('departments')),
    getAllRecords(db.collection('identities')),
    getAllRecords(db.collection('work_groups')),
    getAllRecords(db.collection('score_question_templates'))
  ]);
  const templatesById = new Map();
  templates.forEach((item) => {
    const id = safeString(item && item._id);
    if (!id) return;
    templatesById.set(id, {
      id,
      name: safeString(item.name),
      questionCount: Array.isArray(item.questions) ? item.questions.length : 0,
      questions: Array.isArray(item.questions) ? item.questions : []
    });
  });
  return {
    departmentsById: buildOrgMap(departments),
    identitiesById: buildOrgMap(identities),
    workGroupsById: buildOrgMap(workGroups),
    templatesById
  };
}

function getLookupName(map, id) {
  const row = map && map.get(safeString(id));
  return row ? safeString(row.name) : '';
}

function makeOrgRuleKey(departmentId, identityId) {
  const depId = safeString(departmentId);
  const idId = safeString(identityId);
  return depId && idId ? depId + '::' + idId : '';
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundScore(value) {
  return Number(toNumber(value, 0).toFixed(3));
}

let currentTimezone = 8;

function setTimezone(value) {
  const tz = Number(value);
  if (Number.isInteger(tz) && tz >= -12 && tz <= 14) {
    currentTimezone = tz;
  }
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  const date = value instanceof Date
    ? value
    : (value && typeof value.toDate === 'function' ? value.toDate() : new Date(value));
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const local = new Date(utc + currentTimezone * 3600000);
  const datePart = [
    local.getUTCFullYear(),
    String(local.getUTCMonth() + 1).padStart(2, '0'),
    String(local.getUTCDate()).padStart(2, '0')
  ].join('-');
  const timePart = [
    String(local.getUTCHours()).padStart(2, '0'),
    String(local.getUTCMinutes()).padStart(2, '0'),
    String(local.getUTCSeconds()).padStart(2, '0')
  ].join(':');
  const tzLabel = currentTimezone === 8 ? '' : ` (UTC${currentTimezone >= 0 ? '+' : ''}${currentTimezone})`;
  return `${datePart} ${timePart}${tzLabel}`;
}

function normalizeMember(record = {}, orgLookups = {}) {
  const departmentId = safeString(record.departmentId);
  const identityId = safeString(record.identityId);
  const workGroupId = safeString(record.workGroupId);
  const department = getLookupName(orgLookups.departmentsById, departmentId);
  const identity = getLookupName(orgLookups.identitiesById, identityId);
  const workGroup = getLookupName(orgLookups.workGroupsById, workGroupId) || DEFAULT_WORK_GROUP;

  return {
    id: safeString(record._id),
    name: safeString(record.name),
    studentId: safeString(record.studentId),
    departmentId,
    department,
    identityId,
    identity,
    workGroupId,
    workGroup
  };
}

function enrichScoreRecords(records = [], members = []) {
  const memberById = new Map(members.map((member) => [safeString(member.id), member]));
  return records.map((record) => {
    const scorer = memberById.get(safeString(record.scorerId)) || {};
    const target = memberById.get(safeString(record.targetId)) || {};
    return {
      ...record,
      scorerName: safeString(scorer.name),
      scorerStudentId: safeString(scorer.studentId),
      scorerDepartment: safeString(scorer.department),
      scorerIdentity: safeString(scorer.identity),
      scorerWorkGroup: safeString(scorer.workGroup),
      targetName: safeString(target.name),
      targetStudentId: safeString(target.studentId),
      targetDepartment: safeString(target.department),
      targetIdentity: safeString(target.identity),
      targetWorkGroup: safeString(target.workGroup)
    };
  });
}

function getMemberRuleKey(member = {}) {
  return makeOrgRuleKey(member.departmentId, member.identityId);
}

function getScorerUniqueKey(memberOrRecord = {}) {
  return safeString(memberOrRecord.scorerId || memberOrRecord.id)
    || safeString(memberOrRecord.studentId);
}

function createScorerKeyResolver(members = []) {
  const aliasMap = new Map();

  members.forEach((member) => {
    const canonicalKey = getScorerUniqueKey(member);

    [
      member.id,
      member.studentId,
      member.scorerId
    ].forEach((value) => {
      const key = safeString(value);
      if (key) {
        aliasMap.set(key, canonicalKey);
      }
    });
  });

  return function resolveScorerKey(record = {}) {
    const rawKeys = [
      record.scorerId,
      record.id
    ].map((value) => safeString(value)).filter(Boolean);

    for (const key of rawKeys) {
      if (aliasMap.has(key)) {
        return aliasMap.get(key);
      }
    }

    return rawKeys[0] || '';
  };
}

function normalizeRuleClause(rawClause = {}, orgLookups = {}) {
  const targetIdentityId = safeString(rawClause.targetIdentityId);
  return {
    scopeType: safeString(rawClause.scopeType),
    targetIdentityId,
    targetIdentity: getLookupName(orgLookups.identitiesById, targetIdentityId),
    requireAllComplete: rawClause.requireAllComplete === true,
    templateConfigs: Array.isArray(rawClause.templateConfigs)
      ? rawClause.templateConfigs
        .map((item) => ({
          templateId: safeString(item.templateId),
          templateName: safeString(orgLookups.templatesById && orgLookups.templatesById.get(safeString(item.templateId)) && orgLookups.templatesById.get(safeString(item.templateId)).name),
          weight: toNumber(item.weight, 0),
          sortOrder: toNumber(item.sortOrder, 0)
        }))
        .filter((item) => item.templateId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
      : []
  };
}

function sameDepartment(left = {}, right = {}) {
  return safeString(left.departmentId) && safeString(left.departmentId) === safeString(right.departmentId);
}

function sameWorkGroup(left = {}, right = {}) {
  return safeString(left.workGroupId) && safeString(left.workGroupId) === safeString(right.workGroupId);
}

function matchesTargetIdentity(target = {}, clause = {}) {
  return safeString(target.identityId) && safeString(target.identityId) === safeString(clause.targetIdentityId);
}

function matchesClauseTarget(target, scorer, clause) {
  if (clause.scopeType === 'same_department_identity') {
    return sameDepartment(target, scorer) && matchesTargetIdentity(target, clause);
  }
  if (clause.scopeType === 'same_department_all') {
    return sameDepartment(target, scorer);
  }
  if (clause.scopeType === 'same_work_group_identity') {
    return sameDepartment(target, scorer) && sameWorkGroup(target, scorer) && matchesTargetIdentity(target, clause);
  }
  if (clause.scopeType === 'same_work_group_all') {
    return sameDepartment(target, scorer) && sameWorkGroup(target, scorer);
  }
  if (clause.scopeType === 'identity_only') {
    return matchesTargetIdentity(target, clause);
  }
  if (clause.scopeType === 'all_people') {
    return true;
  }
  return false;
}

function buildTargetBase(record = {}, hrMap) {
  const target = hrMap.get(safeString(record.targetId));
  return {
    targetId: target ? target.id : safeString(record.targetId),
    name: target ? target.name : '',
    studentId: target ? target.studentId : '',
    department: target ? target.department : '',
    identity: target ? target.identity : '',
    workGroup: target ? target.workGroup : DEFAULT_WORK_GROUP
  };
}

function buildCompletionBoard(rows, field, lean) {
  const boardMap = new Map();
  rows.filter((item) => Number(item.expectedCount || 0) > 0).forEach((item) => {
    const key = safeString(item[field]) || '未设置';
    if (!boardMap.has(key)) {
      boardMap.set(key, {
        groupName: key,
        memberCount: 0,
        completedCount: 0,
        pendingCount: 0,
        expectedTotal: 0,
        submittedTotal: 0,
        scorerRows: lean ? undefined : []
      });
    }

    const board = boardMap.get(key);
    const expectedCount = toNumber(item.expectedCount, 0);
    const submittedCount = toNumber(item.submittedCount, 0);
    const pendingCount = Math.max(expectedCount - submittedCount, 0);
    const isCompleted = pendingCount === 0;

    board.memberCount += 1;
    board.completedCount += isCompleted ? 1 : 0;
    board.pendingCount += isCompleted ? 0 : 1;
    board.expectedTotal += expectedCount;
    board.submittedTotal += submittedCount;

    if (!lean) {
      board.scorerRows.push({
        scorerKey: safeString(item.scorerKey),
        scorerId: safeString(item.scorerId),
        scorerName: safeString(item.scorerName),
        scorerStudentId: safeString(item.scorerStudentId),
        department: safeString(item.department),
        identity: safeString(item.identity),
        workGroup: safeString(item.workGroup || DEFAULT_WORK_GROUP),
        expectedCount,
        submittedCount,
        pendingCount,
        completionRate: expectedCount
          ? Number(((submittedCount / expectedCount) * 100).toFixed(2))
          : 100
      });
    }
  });

  return Array.from(boardMap.values())
    .map((item) => ({
      groupName: item.groupName,
      memberCount: item.memberCount,
      completedCount: item.completedCount,
      pendingCount: item.pendingCount,
      expectedTotal: item.expectedTotal,
      submittedTotal: item.submittedTotal,
      completionRate: item.memberCount
        ? Number(((item.completedCount / item.memberCount) * 100).toFixed(2))
        : 100,
      scorerRows: item.scorerRows ? item.scorerRows.sort((a, b) => {
        const pendingDiff = Number(b.pendingCount || 0) - Number(a.pendingCount || 0);
        if (pendingDiff !== 0) {
          return pendingDiff;
        }
        return String(a.scorerName || '').localeCompare(String(b.scorerName || ''), 'zh-CN');
      }) : undefined
    }))
    .sort((a, b) => String(a.groupName || '').localeCompare(String(b.groupName || ''), 'zh-CN'));
}

function buildTaskData(members, rules, records) {
  const resolveScorerKey = createScorerKeyResolver(members);
  const membersByRuleKey = new Map();
  members.forEach((member) => {
    const key = getMemberRuleKey(member);
    if (!membersByRuleKey.has(key)) {
      membersByRuleKey.set(key, []);
    }
    membersByRuleKey.get(key).push(member);
  });

  const expectedPairs = new Map();
  const scorerTaskMap = new Map();
  const targetPendingMap = new Map();

  rules.forEach((rule) => {
    const ruleKey = makeOrgRuleKey(rule.scorerDepartmentId, rule.scorerIdentityId);
    const scorers = membersByRuleKey.get(ruleKey) || [];
    rule.clauses.forEach((clause, clauseIndex) => {
      if (!clause.templateConfigs.length) {
        return;
      }
      scorers.forEach((scorer) => {
        members.forEach((target) => {
          if (!matchesClauseTarget(target, scorer, clause)) {
            return;
          }
          const scorerKey = getScorerUniqueKey(scorer);
          const pairKey = `${scorerKey}::${target.id}`;
          const taskKey = `${safeString(rule._id)}::${clauseIndex}::${scorerKey}::${target.id}`;
          expectedPairs.set(taskKey, {
            taskKey,
            pairKey,
            ruleId: safeString(rule._id),
            clauseIndex,
            requireAllComplete: clause.requireAllComplete === true,
            scorerKey,
            scorerId: scorer.id,
            scorerName: scorer.name,
            scorerStudentId: scorer.studentId,
            scorerDepartment: scorer.department,
            scorerIdentity: scorer.identity,
            scorerWorkGroup: scorer.workGroup || DEFAULT_WORK_GROUP,
            targetId: target.id,
            targetName: target.name,
            targetStudentId: target.studentId,
            targetDepartment: target.department,
            targetIdentity: target.identity,
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
        scorerKey: task.scorerKey,
        scorerId: task.scorerId,
        scorerName: task.scorerName,
        scorerStudentId: task.scorerStudentId,
        department: task.scorerDepartment,
        identity: task.scorerIdentity,
        workGroup: task.scorerWorkGroup,
        expectedTaskKeys: new Set(),
        submittedTaskKeys: new Set()
      });
    }
    scorerTaskMap.get(task.scorerKey).expectedTaskKeys.add(task.taskKey);

    if (!targetPendingMap.has(task.targetId)) {
      targetPendingMap.set(task.targetId, {
        expectedScorerKeys: new Set(),
        submittedScorerKeys: new Set(),
        scorerNameMap: new Map(),
        pendingScorerNames: []
      });
    }
    const targetStat = targetPendingMap.get(task.targetId);
    targetStat.expectedScorerKeys.add(task.scorerKey);
    targetStat.scorerNameMap.set(task.scorerKey, task.scorerName);
  });

  const pairRecordsMap = new Map();
  records.forEach((record) => {
    const scorerKey = resolveScorerKey(record);
    const targetId = safeString(record.targetId);
    if (!scorerKey || !targetId) {
      return;
    }
    const pairKey = `${scorerKey}::${targetId}`;
    if (!pairRecordsMap.has(pairKey)) {
      pairRecordsMap.set(pairKey, []);
    }
    pairRecordsMap.get(pairKey).push(record);
  });

  expectedPairs.forEach((task) => {
    const taskRecords = pairRecordsMap.get(task.pairKey) || [];
    const hasRecord = taskRecords.some((record) => safeString(record.ruleId) === task.ruleId);
    if (!hasRecord) {
      return;
    }
    const scorerStat = scorerTaskMap.get(task.scorerKey);
    if (scorerStat) {
      scorerStat.submittedTaskKeys.add(task.taskKey);
    }
    const targetStat = targetPendingMap.get(task.targetId);
    if (targetStat) {
      targetStat.submittedScorerKeys.add(task.scorerKey);
    }
  });

  targetPendingMap.forEach((targetStat) => {
    const pendingNames = [];
    targetStat.expectedScorerKeys.forEach((scorerKey) => {
      if (!targetStat.submittedScorerKeys.has(scorerKey)) {
        const pair = targetStat.scorerNameMap && targetStat.scorerNameMap.get(scorerKey);
        if (pair) pendingNames.push(pair);
      }
    });
    targetStat.pendingScorerNames = pendingNames;
  });

  const invalidScorerClauseKeys = new Set();
  const scorerClauseTaskMap = new Map();
  expectedPairs.forEach((task) => {
    const key = `${task.ruleId}::${task.clauseIndex}::${task.scorerKey}`;
    if (!scorerClauseTaskMap.has(key)) {
      scorerClauseTaskMap.set(key, {
        requireAllComplete: task.requireAllComplete,
        tasks: []
      });
    }
    scorerClauseTaskMap.get(key).tasks.push(task);
  });

  scorerClauseTaskMap.forEach((bucket, key) => {
    if (!bucket.requireAllComplete) {
      return;
    }
    const hasPending = bucket.tasks.some((task) => {
      const scorerStat = scorerTaskMap.get(task.scorerKey);
      return scorerStat && !scorerStat.submittedTaskKeys.has(task.taskKey);
    });
    if (hasPending) {
      invalidScorerClauseKeys.add(key);
    }
  });

  const scorerTaskRows = Array.from(scorerTaskMap.values())
    .map((item) => ({
      scorerKey: item.scorerKey,
      scorerId: item.scorerId,
      scorerName: item.scorerName,
      scorerStudentId: item.scorerStudentId,
      department: item.department,
      identity: item.identity,
      workGroup: item.workGroup,
      expectedCount: item.expectedTaskKeys.size,
      submittedCount: item.submittedTaskKeys.size,
      pendingCount: Math.max(item.expectedTaskKeys.size - item.submittedTaskKeys.size, 0),
      completionRate: item.expectedTaskKeys.size
        ? Number(((item.submittedTaskKeys.size / item.expectedTaskKeys.size) * 100).toFixed(2))
        : 0
    }))
    .sort((a, b) => {
      if (a.pendingCount !== b.pendingCount) {
        return b.pendingCount - a.pendingCount;
      }
      return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN');
    });

  return {
    scorerTaskRows,
    targetPendingMap,
    invalidScorerClauseKeys,
    expectedPairs: Array.from(expectedPairs.values())
  };
}

function applyFiltersToRows(payload, filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);
  const isAll = (value) => !value
    || value === '全部'
    || value === '全部部门'
    || value === '全部身份'
    || value === '全部工作分工'
    || value === '全部工作分工（职能组）'
    || value === '鍏ㄩ儴';

  const matches = (row) => {
    if (!isAll(department) && safeString(row.department) !== department) {
      return false;
    }
    if (!isAll(identity) && safeString(row.identity) !== identity) {
      return false;
    }
    if (!isAll(workGroup) && safeString(row.workGroup || DEFAULT_WORK_GROUP) !== workGroup) {
      return false;
    }
    return true;
  };

  const overviewRows = (payload.overviewRows || []).filter(matches);
  const calculationRows = (payload.calculationRows || []).filter(matches);
  const detailRows = (payload.detailRows || []).filter(matches);
  const recordRows = (payload.recordRows || []).filter(matches);
  const scorerCompletionRows = (payload.scorerCompletionRows || []).filter(matches);

  return {
    overviewRows,
    calculationRows,
    detailRows,
    recordRows,
    scorerCompletionRows
  };
}

const RESPONSE_SAFE_LIMIT = 850 * 1024; // 留余量，别卡 1MB 极限

function estimateBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function sliceRowsBySize(rows, offset, basePayload, rowFieldName) {
  const start = Math.max(0, Math.floor(toNumber(offset, 0)));
  const selected = [];

  for (let i = start; i < rows.length; i += 1) {
    selected.push(rows[i]);

    const testPayload = {
      ...basePayload,
      [rowFieldName]: selected
    };

    if (estimateBytes(testPayload) > RESPONSE_SAFE_LIMIT) {
      selected.pop();
      return {
        rows: selected,
        nextOffset: i,
        hasMore: true,
        total: rows.length
      };
    }
  }

  return {
    rows: selected,
    nextOffset: rows.length,
    hasMore: false,
    total: rows.length
  };
}

function getRowFieldName(dataType) {
  if (dataType === 'calculation') {
    return 'calculationRows';
  }
  if (dataType === 'detail') {
    return 'detailRows';
  }
  if (dataType === 'records' || dataType === 'record') {
    return 'recordRows';
  }
  if (dataType === 'completion') {
    return 'scorerCompletionRows';
  }
  return 'overviewRows';
}

function isAllFilterValue(value, allLabels = []) {
  const text = safeString(value);
  return !text || allLabels.includes(text) || text === '鍏ㄩ儴';
}

function buildHrInfoQuery(filters = {}) {
  const collection = db.collection('hr_info');
  return collection;
}

function chunkArray(items = [], size = 100) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildScoreResponseFromPayload(payload, filters, dataType, offset) {
  const normalizedDataType = dataType === 'record' ? 'records' : (dataType || 'overview');
  const rowFieldName = getRowFieldName(normalizedDataType);
  const filteredData = applyFiltersToRows(payload, filters);
  const sourceRows = filteredData[rowFieldName] || [];

  const basePayload = {
    status: 'success',
    activity: payload.activity || {},
    overviewRows: [],
    calculationRows: [],
    detailRows: [],
    recordRows: [],
    scorerCompletionRows: [],
    scorerTaskRows: [],
    completionBoards: {
      departments: []
    },
    stats: payload.stats || {},
    filterOptions: payload.filterOptions || {},
    pagination: {
      offset,
      nextOffset: offset,
      total: 0,
      hasMore: false,
      returnedCount: 0
    }
  };

  const pageResult = sliceRowsBySize(sourceRows, offset, basePayload, rowFieldName);
  basePayload[rowFieldName] = pageResult.rows;

  if (normalizedDataType === 'completion') {
    basePayload.completionBoards = {
      departments: buildCompletionBoard(sourceRows, 'department', true)
    };
  }

  basePayload.pagination = {
    offset,
    nextOffset: pageResult.nextOffset,
    total: sourceRows.length,
    hasMore: pageResult.hasMore,
    returnedCount: pageResult.rows.length
  };

  return basePayload;
}

function buildLeanOverviewRows(rows = []) {
  return rows.map((row) => ({
    id: safeString(row.id || row.targetId),
    targetId: safeString(row.targetId || row.id),
    name: safeString(row.name || row.targetName),
    studentId: safeString(row.studentId || row.targetStudentId),
    department: safeString(row.department),
    identity: safeString(row.identity),
    workGroup: safeString(row.workGroup || DEFAULT_WORK_GROUP),
    finalScore: roundScore(row.finalScore),
    expectedScorerCount: toNumber(row.expectedScorerCount, 0),
    submittedScorerCount: toNumber(row.submittedScorerCount, 0),
    pendingScorerCount: toNumber(row.pendingScorerCount, 0),
    completionRate: toNumber(row.completionRate, 0)
  }));
}

function buildOverviewResponse(payload, filters, offset) {
  const leanPayload = {
    ...payload,
    overviewRows: buildLeanOverviewRows(payload.overviewRows || []),
    calculationRows: [],
    detailRows: [],
    recordRows: [],
    scorerCompletionRows: []
  };
  return buildScoreResponseFromPayload(leanPayload, filters, 'overview', offset);
}

function normalizeRules(rawRules = [], orgLookups = {}) {
  return rawRules.map((item) => {
    const scorerDepartmentId = safeString(item.scorerDepartmentId);
    const scorerIdentityId = safeString(item.scorerIdentityId);
    const scorerDepartment = getLookupName(orgLookups.departmentsById, scorerDepartmentId);
    const scorerIdentity = getLookupName(orgLookups.identitiesById, scorerIdentityId);
    const idKey = makeOrgRuleKey(scorerDepartmentId, scorerIdentityId);
    return {
      ...item,
      scorerKey: idKey,
      scorerDepartmentId,
      scorerIdentityId,
      scorerDepartment,
      scorerIdentity,
      clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause, orgLookups)) : []
    };
  });
}

function buildActivityBrief(activity = {}) {
  return {
    id: safeString(activity._id),
    name: safeString(activity.name),
    description: safeString(activity.description)
  };
}

function buildOverviewFilterOptions(rows = []) {
  return {
    departments: Array.from(new Set(rows.map((item) => item.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    identities: Array.from(new Set(rows.map((item) => item.identity).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    workGroups: Array.from(new Set(rows.map((item) => item.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  };
}

function buildOverviewPayload(activity, overviewRows) {
  return {
    status: 'success',
    activity,
    overviewRows,
    stats: {
      totalMembers: overviewRows.length,
      scoredMembers: overviewRows.filter((item) => Number(item.finalScore || 0) > 0).length
    },
    filterOptions: buildOverviewFilterOptions(overviewRows)
  };
}

function filterMembersByResultFilters(members = [], filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);

  return members.filter((member) => {
    if (!isAllFilterValue(department, ['全部', '全部部门']) && safeString(member.department) !== department) {
      return false;
    }
    if (!isAllFilterValue(identity, ['全部', '全部身份']) && safeString(member.identity) !== identity) {
      return false;
    }
    if (!isAllFilterValue(workGroup, ['全部', '全部工作分工', '全部工作分工（职能组）'])
      && safeString(member.workGroup || DEFAULT_WORK_GROUP) !== workGroup) {
      return false;
    }
    return true;
  });
}

function buildExpectedTargetRows(members = [], rules = []) {
  const membersByRuleKey = new Map();
  members.forEach((member) => {
    const key = getMemberRuleKey(member);
    if (!membersByRuleKey.has(key)) {
      membersByRuleKey.set(key, []);
    }
    membersByRuleKey.get(key).push(member);
  });

  const targetMap = new Map(members.map((member) => [member.id, {
    targetId: member.id,
    expectedScorerCount: 0,
    expectedScorers: []
  }]));

  rules.forEach((rule) => {
    const scorers = membersByRuleKey.get(rule.scorerKey) || [];
    rule.clauses.forEach((clause, clauseIndex) => {
      if (!clause.templateConfigs.length) {
        return;
      }
      scorers.forEach((scorer) => {
        const scorerKey = getScorerUniqueKey(scorer);
        members.forEach((target) => {
          if (!matchesClauseTarget(target, scorer, clause)) {
            return;
          }
          const row = targetMap.get(target.id);
          if (!row) {
            return;
          }
          row.expectedScorers.push({
            ruleId: safeString(rule._id),
            clauseIndex,
            requireAllComplete: clause.requireAllComplete === true,
            scorerKey,
            scorerId: scorer.id,
            scorerName: scorer.name,
            scorerStudentId: scorer.studentId,
            scorerDepartment: scorer.department,
            scorerIdentity: scorer.identity,
            scorerWorkGroup: scorer.workGroup || DEFAULT_WORK_GROUP
          });
        });
      });
    });
  });

  targetMap.forEach((row) => {
    row.expectedScorerCount = new Set(row.expectedScorers.map((item) => item.scorerKey).filter(Boolean)).size;
  });

  return Array.from(targetMap.values());
}

function buildExpectedTargetRowForTarget(members = [], rules = [], targetId) {
  const target = members.find((member) => safeString(member.id) === safeString(targetId));
  if (!target) {
    return {
      targetId: safeString(targetId),
      expectedScorerCount: 0,
      expectedScorers: []
    };
  }

  const membersByRuleKey = new Map();
  members.forEach((member) => {
    const key = getMemberRuleKey(member);
    if (!membersByRuleKey.has(key)) {
      membersByRuleKey.set(key, []);
    }
    membersByRuleKey.get(key).push(member);
  });

  const expectedScorers = [];
  rules.forEach((rule) => {
    const scorers = membersByRuleKey.get(rule.scorerKey) || [];
    rule.clauses.forEach((clause, clauseIndex) => {
      if (!clause.templateConfigs.length) {
        return;
      }
      scorers.forEach((scorer) => {
        if (!matchesClauseTarget(target, scorer, clause)) {
          return;
        }
        expectedScorers.push({
          ruleId: safeString(rule._id),
          clauseIndex,
          requireAllComplete: clause.requireAllComplete === true,
          scorerKey: getScorerUniqueKey(scorer),
          scorerId: scorer.id,
          scorerName: scorer.name,
          scorerStudentId: scorer.studentId,
          scorerDepartment: scorer.department,
          scorerIdentity: scorer.identity,
          scorerWorkGroup: scorer.workGroup || DEFAULT_WORK_GROUP
        });
      });
    });
  });

  return {
    targetId: target.id,
    expectedScorerCount: new Set(expectedScorers.map((item) => item.scorerKey).filter(Boolean)).size,
    expectedScorers
  };
}

async function getExpectedTargetRows(activityId, members = [], rules = []) {
  return buildExpectedTargetRows(members, rules);
}

async function getScoreRecordsForTargets(activityId, targetIds = []) {
  const ids = Array.from(new Set((targetIds || []).map((item) => safeString(item)).filter(Boolean)));
  if (!ids.length) {
    return [];
  }
  if (ids.length >= 100) {
    return getAllRecords(db.collection('score_records').where({ activityId }));
  }
  const batches = await Promise.all(chunkArray(ids, 50).map((chunk) => (
    getAllRecords(db.collection('score_records').where({
      activityId,
      targetId: _.in(chunk)
    }))
  )));
  return batches.flat();
}

function getRecordScorerAliases(record = {}, fallbackKey = '') {
  return [
    fallbackKey,
    record.scorerId
  ].map((value) => safeString(value)).filter(Boolean);
}

function getExpectedScorerAliases(task = {}) {
  return [
    task.scorerKey,
    task.scorerId,
    task.scorerId,
    task.id,
    task.openid,
    task.scorerOpenId
  ].map((value) => safeString(value)).filter(Boolean);
}

function scorerAliasesMatch(recordAliases = [], task = {}) {
  const taskAliases = new Set(getExpectedScorerAliases(task));
  return recordAliases.some((alias) => taskAliases.has(alias));
}

function findExpectedScorerTask(record = {}, fallbackScorerKey, expectedRows = []) {
  const ruleId = safeString(record.ruleId);
  const targetId = safeString(record.targetId);
  const aliases = getRecordScorerAliases(record, fallbackScorerKey);
  for (const row of expectedRows || []) {
    if (safeString(row.targetId) !== targetId) {
      continue;
    }
    const task = (row.expectedScorers || []).find((item) => (
      safeString(item.ruleId) === ruleId && scorerAliasesMatch(aliases, item)
    ));
    if (task) {
      return task;
    }
  }
  return null;
}

function calculateInvalidScorerClauseKeys(expectedRows = [], records = [], resolveScorerKey) {
  const expectedTaskIndex = new Map();
  expectedRows.forEach((row) => {
    const targetId = safeString(row.targetId);
    (row.expectedScorers || []).forEach((task) => {
      const ruleId = safeString(task.ruleId);
      const scorerKey = safeString(task.scorerKey);
      getExpectedScorerAliases(task).forEach((alias) => {
        const indexKey = `${ruleId}::${alias}::${targetId}`;
        if (!expectedTaskIndex.has(indexKey)) {
          expectedTaskIndex.set(indexKey, []);
        }
        expectedTaskIndex.get(indexKey).push({
          ruleId,
          scorerKey,
          targetId,
          clauseIndex: toNumber(task.clauseIndex, 0),
          requireAllComplete: task.requireAllComplete === true
        });
      });
    });
  });

  const submittedTaskKeys = new Set();
  records.forEach((record) => {
    const targetId = safeString(record.targetId);
    const ruleId = safeString(record.ruleId);
    getRecordScorerAliases(record, resolveScorerKey(record)).forEach((alias) => {
      const tasks = expectedTaskIndex.get(`${ruleId}::${alias}::${targetId}`) || [];
      tasks.forEach((task) => {
        submittedTaskKeys.add(`${task.ruleId}::${task.clauseIndex}::${task.scorerKey}::${task.targetId}`);
      });
    });
  });

  const bucketMap = new Map();
  expectedRows.forEach((row) => {
    const targetId = safeString(row.targetId);
    (row.expectedScorers || []).forEach((task) => {
      const ruleId = safeString(task.ruleId);
      const scorerKey = safeString(task.scorerKey);
      const key = `${ruleId}::${toNumber(task.clauseIndex, 0)}::${scorerKey}`;
      if (!bucketMap.has(key)) {
        bucketMap.set(key, {
          ruleId,
          scorerKey,
          clauseIndex: toNumber(task.clauseIndex, 0),
          requireAllComplete: task.requireAllComplete === true,
          targetIds: []
        });
      }
      bucketMap.get(key).targetIds.push(targetId);
    });
  });

  const invalidPairs = new Set();
  bucketMap.forEach((bucket, bucketKey) => {
    if (!bucket.requireAllComplete) {
      return;
    }
    const hasPending = bucket.targetIds.some((targetId) => (
      !submittedTaskKeys.has(`${bucket.ruleId}::${bucket.clauseIndex}::${bucket.scorerKey}::${targetId}`)
    ));
    if (hasPending && bucket.ruleId && bucket.scorerKey) {
      invalidPairs.add(bucketKey);
    }
  });
  return invalidPairs;
}

function findRecordScorerClauseKey(record = {}, scorerKey, expectedRows = []) {
  const ruleId = safeString(record.ruleId);
  const task = findExpectedScorerTask(record, scorerKey, expectedRows);
  if (task) {
    return `${ruleId}::${toNumber(task.clauseIndex, 0)}::${safeString(task.scorerKey || scorerKey)}`;
  }
  return `${ruleId}::0::${safeString(scorerKey)}`;
}

function findRecordScorerClauseKeyFromPairs(record = {}, scorerKey, expectedPairs = []) {
  const ruleId = safeString(record.ruleId);
  const targetId = safeString(record.targetId);
  const aliases = getRecordScorerAliases(record, scorerKey);
  const task = (expectedPairs || []).find((item) => (
    safeString(item.targetId) === targetId
    && safeString(item.ruleId) === ruleId
    && scorerAliasesMatch(aliases, item)
  ));
  if (task) {
    return `${ruleId}::${toNumber(task.clauseIndex, 0)}::${safeString(task.scorerKey || scorerKey)}`;
  }
  return `${ruleId}::0::${safeString(scorerKey)}`;
}

function findExpectedPairTask(record = {}, scorerKey, expectedPairs = []) {
  const ruleId = safeString(record.ruleId);
  const targetId = safeString(record.targetId);
  const aliases = getRecordScorerAliases(record, scorerKey);
  return (expectedPairs || []).find((item) => (
    safeString(item.targetId) === targetId
    && safeString(item.ruleId) === ruleId
    && scorerAliasesMatch(aliases, item)
  )) || null;
}

function findCurrentTemplateConfig(rule = {}, clauseIndex = 0, templateId = '', fallback = {}) {
  const clauses = Array.isArray(rule.clauses) ? rule.clauses : [];
  const normalizedTemplateId = safeString(templateId);
  const clause = clauses[toNumber(clauseIndex, 0)] || {};
  const directConfig = (Array.isArray(clause.templateConfigs) ? clause.templateConfigs : [])
    .find((item) => safeString(item.templateId) === normalizedTemplateId);
  if (directConfig) {
    return directConfig;
  }
  for (const item of clauses) {
    const config = (Array.isArray(item.templateConfigs) ? item.templateConfigs : [])
      .find((templateConfig) => safeString(templateConfig.templateId) === normalizedTemplateId);
    if (config) {
      return config;
    }
  }
  return fallback || {};
}

function getCurrentTemplateWeight(rule = {}, clauseIndex = 0, templateId = '', fallback = {}) {
  const config = findCurrentTemplateConfig(rule, clauseIndex, templateId, fallback);
  const weight = toNumber(config.weight, NaN);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function getRecordTemplateScores(record = {}, rule = {}, expectedTask = null, orgLookups = {}) {
  const configs = (Array.isArray(record.templateConfigs) && record.templateConfigs.length
    ? record.templateConfigs
    : ((rule.clauses || [])[toNumber(expectedTask && expectedTask.clauseIndex, 0)] || {}).templateConfigs || [])
    .map((item) => {
      const templateId = safeString(item.templateId);
      const template = orgLookups.templatesById && orgLookups.templatesById.get(templateId);
      return {
        templateId,
        templateName: safeString(template && template.name),
        weight: toNumber(item.weight, 0),
        sortOrder: toNumber(item.sortOrder, 0),
        questionCount: toNumber(template && template.questionCount, 0),
        questions: Array.isArray(template && template.questions) ? template.questions : []
      };
    })
    .filter((item) => item.templateId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const answers = Array.isArray(record.answers) ? record.answers : [];
  const answerMap = new Map(answers.map((item, index) => [
    String(item.questionIndex == null ? index : item.questionIndex),
    toNumber(item.score, 0)
  ]));
  let cursor = 0;
  return configs.map((config) => {
    const questionCount = config.questionCount || answers.filter((item) => safeString(item.templateId) === config.templateId).length;
    let score = 0;
    if (questionCount) {
      for (let index = 0; index < questionCount; index += 1) {
        score += toNumber(answerMap.get(String(cursor + index)), 0);
      }
    } else {
      answers
        .filter((item) => safeString(item.templateId) === config.templateId)
        .forEach((item) => { score += toNumber(item.score, 0); });
    }
    cursor += questionCount;
    return { ...config, score };
  });
}

function buildOverviewRowsLight(activityId, members = [], rules = [], records = [], expectedRows = [], scorerMembers = members, allExpectedRowsForInvalid = expectedRows, orgLookups = {}) {
  const hrMap = new Map(members.map((item) => [item.id, item]));
  const ruleById = new Map(rules.map((item) => [safeString(item._id), item]));
  const resolveScorerKey = createScorerKeyResolver(scorerMembers);
  const invalidScorerClauseKeys = calculateInvalidScorerClauseKeys(allExpectedRowsForInvalid, records, resolveScorerKey);
  const expectedByTarget = new Map(expectedRows.map((item) => [safeString(item.targetId), item]));
  const submittedByTarget = new Map();
  const calculationMap = new Map();
  const memberScoreMap = new Map();

  records.forEach((record) => {
    const targetBase = buildTargetBase(record, hrMap);
    if (!targetBase.targetId) {
      return;
    }

    const rule = ruleById.get(safeString(record.ruleId)) || {};
    const scorerDepartment = safeString(rule.scorerDepartment);
    const scorerIdentity = safeString(rule.scorerIdentity);
    const scorerCategoryKey = `${scorerDepartment}::${scorerIdentity}`;
    const resolvedScorerKey = resolveScorerKey(record);
    const expectedTask = findExpectedScorerTask(record, resolvedScorerKey, allExpectedRowsForInvalid);
    const scorerKey = safeString((expectedTask && expectedTask.scorerKey) || resolvedScorerKey || record.scorerId);
    const excludedByRequireAll = invalidScorerClauseKeys.has(findRecordScorerClauseKey(record, scorerKey, allExpectedRowsForInvalid));

    if (!excludedByRequireAll && scorerKey) {
      if (!submittedByTarget.has(targetBase.targetId)) {
        submittedByTarget.set(targetBase.targetId, new Set());
      }
      submittedByTarget.get(targetBase.targetId).add(scorerKey);
    }

    getRecordTemplateScores(record, rule, expectedTask, orgLookups).forEach((templateItem) => {
      if (excludedByRequireAll) {
        return;
      }
      const templateId = safeString(templateItem.templateId);
      const templateName = safeString(templateItem.templateName);
      const weight = getCurrentTemplateWeight(rule, expectedTask && expectedTask.clauseIndex, templateId, templateItem);
      const templateScore = toNumber(templateItem.score, 0);
      const groupKey = [targetBase.targetId, scorerCategoryKey, templateId].join('||');

      if (!calculationMap.has(groupKey)) {
        calculationMap.set(groupKey, {
          targetId: targetBase.targetId,
          templateName,
          weight,
          recordCount: 0,
          sumScore: 0
        });
      }

      const bucket = calculationMap.get(groupKey);
      bucket.recordCount += 1;
      bucket.sumScore += templateScore;
    });
  });

  calculationMap.forEach((item) => {
    if (!item.recordCount) {
      return;
    }
    const averageScore = item.sumScore / item.recordCount;
    const contributionScore = averageScore * item.weight;
    const scoreStat = memberScoreMap.get(item.targetId) || {
      finalScore: 0,
      scoredRecordCount: 0,
      scoredTemplateCount: 0
    };
    scoreStat.finalScore += contributionScore;
    scoreStat.scoredRecordCount += item.recordCount;
    scoreStat.scoredTemplateCount += 1;
    memberScoreMap.set(item.targetId, scoreStat);
  });

  return members.map((member) => {
    const expectedRow = expectedByTarget.get(member.id) || {};
    const scoreStat = memberScoreMap.get(member.id) || {};
    const submittedCount = (submittedByTarget.get(member.id) || new Set()).size;
    const expectedCount = Math.max(toNumber(expectedRow.expectedScorerCount, 0), submittedCount);
    const pendingCount = Math.max(expectedCount - submittedCount, 0);
    return {
      id: member.id,
      targetId: member.id,
      name: member.name,
      studentId: member.studentId,
      department: member.department,
      identity: member.identity,
      workGroup: member.workGroup || DEFAULT_WORK_GROUP,
      finalScore: roundScore(scoreStat.finalScore),
      scoredRecordCount: toNumber(scoreStat.scoredRecordCount, 0),
      scoredTemplateCount: toNumber(scoreStat.scoredTemplateCount, 0),
      expectedScorerCount: expectedCount,
      submittedScorerCount: submittedCount,
      pendingScorerCount: pendingCount,
      completionRate: expectedCount
        ? Number(((submittedCount / expectedCount) * 100).toFixed(2))
        : 0
    };
  });
}

function filterScorerRows(rows, filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);

  return rows.filter((row) => {
    if (!isAllFilterValue(department, ['全部', '全部部门']) && safeString(row.department) !== department) return false;
    if (!isAllFilterValue(identity, ['全部', '全部身份']) && safeString(row.identity) !== identity) return false;
    if (!isAllFilterValue(workGroup, ['全部', '全部工作分工', '全部工作分工（职能组）']) && safeString(row.workGroup || DEFAULT_WORK_GROUP) !== workGroup) return false;
    return true;
  });
}

async function handleCompletionRequest(activityId, filters, offset, departmentName) {
  const [activityRes, membersRaw, rulesRaw, recordsRaw, orgLookups] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId })),
    getAllRecords(db.collection('score_records').where({ activityId })),
    fetchOrgLookups()
  ]);

  if (!activityRes.data) {
    return { status: 'activity_not_found', message: '未找到对应的评分活动' };
  }

  const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
  const records = enrichScoreRecords(recordsRaw, members);
  const activityBrief = buildActivityBrief(activityRes.data);
  const rules = normalizeRules(rulesRaw, orgLookups);
  const taskData = buildTaskData(members, rules, records);
  const scorerTaskRowMap = new Map((taskData.scorerTaskRows || []).map((item) => [item.scorerKey, item]));

  const allScorerRows = members.map((member) => {
    const scorerKey = getScorerUniqueKey(member);
    const taskRow = scorerTaskRowMap.get(scorerKey) || {};
    const expectedCount = toNumber(taskRow.expectedCount, 0);
    const submittedCount = toNumber(taskRow.submittedCount, 0);
    const pendingCount = Math.max(expectedCount - submittedCount, 0);
    return {
      scorerKey,
      scorerId: member.id,
      scorerName: member.name,
      scorerStudentId: member.studentId,
      department: member.department,
      identity: member.identity,
      workGroup: member.workGroup || DEFAULT_WORK_GROUP,
      expectedCount,
      submittedCount,
      pendingCount,
      completionRate: expectedCount
        ? Number(((submittedCount / expectedCount) * 100).toFixed(2))
        : 100
    };
  });

  const filteredRows = filterScorerRows(allScorerRows, filters);
  const deptName = safeString(departmentName);

  if (deptName) {
    const deptRows = filteredRows
      .filter((row) => safeString(row.department) === deptName)
      .sort((a, b) => {
        if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount;
        return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN');
      });
    return {
      status: 'success',
      activity: activityBrief,
      scorerCompletionRows: deptRows
    };
  }

  return {
    status: 'success',
    activity: activityBrief,
    completionBoards: {
      departments: buildCompletionBoard(filteredRows, 'department', true)
    },
    stats: {
      totalMembers: members.length,
      completedMembers: allScorerRows.filter((item) => Number(item.pendingCount || 0) === 0).length
    },
    filterOptions: {
      departments: Array.from(new Set(allScorerRows.map((item) => item.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      identities: Array.from(new Set(allScorerRows.map((item) => item.identity).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      workGroups: Array.from(new Set(allScorerRows.map((item) => item.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    }
  };
}

async function handleScorerTargetsRequest(activityId, scorerKey) {
  if (!scorerKey) {
    return {
      status: 'invalid_params',
      message: '请选择要查看的评分人'
    };
  }

  const [activityRes, membersRaw, rulesRaw, recordsRaw, orgLookups] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId })),
    getAllRecords(db.collection('score_records').where({ activityId })),
    fetchOrgLookups()
  ]);

  if (!activityRes.data) {
    return { status: 'activity_not_found', message: '未找到对应的评分活动' };
  }

  const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
  const records = enrichScoreRecords(recordsRaw, members);
  const activityBrief = buildActivityBrief(activityRes.data);
  const rules = normalizeRules(rulesRaw, orgLookups);
  const taskData = buildTaskData(members, rules, records);

  const expectedTargets = new Map();
  (taskData.expectedPairs || []).forEach((pair) => {
    if (pair.scorerKey !== scorerKey) return;
    if (!expectedTargets.has(pair.targetId)) {
      expectedTargets.set(pair.targetId, {
        targetId: pair.targetId,
        targetName: pair.targetName,
        targetStudentId: pair.targetStudentId,
        targetDepartment: pair.targetDepartment,
        targetIdentity: pair.targetIdentity,
        targetWorkGroup: pair.targetWorkGroup || DEFAULT_WORK_GROUP
      });
    }
  });

  const resolveScorerKey = createScorerKeyResolver(members);
  const submittedTargetIds = new Set();
  const submittedRecordMap = new Map();
  records.forEach((record) => {
    const recordScorerKey = resolveScorerKey(record);
    if (recordScorerKey !== scorerKey) return;
    const targetId = safeString(record.targetId);
    if (expectedTargets.has(targetId)) {
      submittedTargetIds.add(targetId);
      submittedRecordMap.set(targetId, safeString(record._id));
    }
  });

  const scorerTargetRows = Array.from(expectedTargets.values())
    .map((target) => {
      const isSubmitted = submittedTargetIds.has(target.targetId);
      return {
        targetId: target.targetId,
        targetName: target.targetName,
        targetStudentId: target.targetStudentId,
        targetDepartment: target.targetDepartment,
        targetIdentity: target.targetIdentity,
        targetWorkGroup: target.targetWorkGroup,
        status: isSubmitted ? 'submitted' : 'pending',
        statusText: isSubmitted ? '已评' : '未评',
        statusClass: isSubmitted ? 'status-completed' : 'status-pending',
        recordId: isSubmitted ? (submittedRecordMap.get(target.targetId) || '') : ''
      };
    })
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'pending' ? -1 : 1;
      }
      return String(a.targetName).localeCompare(String(b.targetName), 'zh-CN');
    });

  const scorerMember = members.find((m) => getScorerUniqueKey(m) === scorerKey);
  const scorerName = scorerMember ? scorerMember.name : scorerKey;

  return {
    status: 'success',
    activity: activityBrief,
    scorerName,
    scorerTargetRows
  };
}

async function handleOverviewRequest(activityId, filters, offset) {
  const [activityRes, membersRaw, rulesRaw, orgLookups] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId })),
    fetchOrgLookups()
  ]);

  if (!activityRes.data) {
    return {
      status: 'activity_not_found',
      message: '未找到对应的评分活动'
    };
  }

  const allMembers = membersRaw.map((item) => normalizeMember(item, orgLookups));
  const members = filterMembersByResultFilters(allMembers, filters);
  const activityBrief = buildActivityBrief(activityRes.data);

  const targetRecords = await getScoreRecordsForTargets(activityId, members.map((member) => member.id));
  const ruleMembers = allMembers;
  const rules = normalizeRules(rulesRaw, orgLookups);
  const hasRequireAllCompleteRule = rules.some((rule) => (
    (rule.clauses || []).some((clause) => clause.requireAllComplete === true)
  ));
  const rawRecords = hasRequireAllCompleteRule
    ? await getAllRecords(db.collection('score_records').where({ activityId }))
    : targetRecords;
  const records = enrichScoreRecords(rawRecords, ruleMembers);
  const allExpectedRows = await getExpectedTargetRows(activityId, ruleMembers, rules);
  const visibleTargetIdSet = new Set(members.map((member) => member.id));
  const expectedRows = allExpectedRows.filter((row) => visibleTargetIdSet.has(safeString(row.targetId)));
  const overviewRows = buildOverviewRowsLight(activityId, members, rules, records, expectedRows, ruleMembers, allExpectedRows, orgLookups);

  return buildOverviewResponse(buildOverviewPayload(activityBrief, overviewRows), filters, offset);
}

function flattenExpectedPairsForTarget(expectedRows = [], targetId) {
  const row = expectedRows.find((item) => safeString(item.targetId) === safeString(targetId)) || {};
  return (Array.isArray(row.expectedScorers) ? row.expectedScorers : []).map((task) => ({
    ...task,
    targetId: safeString(targetId)
  }));
}

function buildTargetRecordPayloadLight(activityBrief, activityId, targetId, members = [], rules = [], records = [], expectedRows = []) {
  const ruleById = new Map(rules.map((item) => [safeString(item._id), item]));
  const resolveScorerKey = createScorerKeyResolver(members);
  const memberByScorerKey = new Map(members.map((member) => [getScorerUniqueKey(member), member]));
  const invalidScorerClauseKeys = calculateInvalidScorerClauseKeys(expectedRows, records, resolveScorerKey);
  const targetRecords = records.filter((record) => safeString(record.targetId) === safeString(targetId));
  const recordRows = targetRecords.map((record) => {
    const rule = ruleById.get(safeString(record.ruleId)) || {};
    const scorerDepartment = safeString(rule.scorerDepartment);
    const scorerIdentity = safeString(rule.scorerIdentity);
    const resolvedScorerKey = resolveScorerKey(record);
    const expectedTask = findExpectedScorerTask(record, resolvedScorerKey, expectedRows);
    const scorerKey = safeString((expectedTask && expectedTask.scorerKey) || resolvedScorerKey || record.scorerId);
    const scorerMember = memberByScorerKey.get(scorerKey) || {};
    return {
      recordId: safeString(record._id),
      activityId,
      activityName: safeString(activityBrief.name),
      scorerKey,
      scorerId: safeString(record.scorerId),
      scorerName: safeString(record.scorerName),
      scorerStudentId: safeString(record.scorerStudentId),
      scorerDepartment,
      scorerIdentity,
      scorerWorkGroup: safeString(scorerMember.workGroup),
      scorerCategoryLabel: [scorerDepartment, scorerIdentity].filter(Boolean).join(' / ') || '未匹配评分人类别',
      targetId: safeString(record.targetId),
      submittedAt: formatDate(record.submittedAt),
      excludedByRequireAll: invalidScorerClauseKeys.has(findRecordScorerClauseKey(record, scorerKey, expectedRows))
    };
  });

  return {
    status: 'success',
    activity: activityBrief,
    expectedPairs: flattenExpectedPairsForTarget(expectedRows, targetId),
    recordRows,
    stats: {
      recordCount: recordRows.length
    }
  };
}

function buildTargetRecordPayloadFromExpectRow(activityBrief, activityId, targetId, expectRow = {}, records = [], invalidScorerClauseKeys = new Set(), invalidExpectedRows = [expectRow]) {
  const expectedScorers = Array.isArray(expectRow.expectedScorers) ? expectRow.expectedScorers : [];
  const expectedByKey = new Map();
  const aliasMap = new Map();
  expectedScorers.forEach((task) => {
    const scorerKey = safeString(task.scorerKey);
    if (scorerKey && !expectedByKey.has(scorerKey)) {
      expectedByKey.set(scorerKey, task);
    }
    [task.scorerKey, task.scorerId, task.scorerStudentId].forEach((value) => {
      const alias = safeString(value);
      if (alias && scorerKey) {
        aliasMap.set(alias, scorerKey);
      }
    });
  });

  const recordRows = records.map((record) => {
    const rawKey = safeString(record.scorerId);
    const scorerKey = aliasMap.get(rawKey) || rawKey;
    const task = expectedByKey.get(scorerKey) || {};
    const scorerDepartment = safeString(task.scorerDepartment || record.scorerDepartment);
    const scorerIdentity = safeString(task.scorerIdentity || record.scorerIdentity);
    const excludedByRequireAll = invalidScorerClauseKeys.has(findRecordScorerClauseKey(record, scorerKey, invalidExpectedRows));
    return {
      recordId: safeString(record._id),
      activityId,
      activityName: safeString(activityBrief.name),
      scorerKey,
      scorerId: safeString(record.scorerId),
      scorerName: safeString(task.scorerName),
      scorerStudentId: safeString(task.scorerStudentId),
      scorerDepartment,
      scorerIdentity,
      scorerWorkGroup: safeString(task.scorerWorkGroup),
      scorerCategoryLabel: [scorerDepartment, scorerIdentity].filter(Boolean).join(' / ') || '未匹配评分人类别',
      targetId: safeString(record.targetId),
      submittedAt: formatDate(record.submittedAt),
      excludedByRequireAll
    };
  });

  return {
    status: 'success',
    activity: activityBrief,
    expectedPairs: flattenExpectedPairsForTarget([expectRow], targetId),
    recordRows,
    stats: {
      recordCount: recordRows.length
    }
  };
}

async function handleTargetRecordsRequest(activityId, targetId, offset) {
  if (!targetId) {
    return {
      status: 'invalid_params',
      message: '请选择要查看的成员'
    };
  }

  const [activityRes, targetRecordsRaw, membersRaw, rulesRaw, orgLookups] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    getAllRecords(db.collection('score_records').where({ activityId, targetId })),
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId })),
    fetchOrgLookups()
  ]);

  if (!activityRes.data) {
    return {
      status: 'activity_not_found',
      message: '未找到对应的评分活动'
    };
  }

  const activityBrief = buildActivityBrief(activityRes.data);
  const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
  const rules = normalizeRules(rulesRaw, orgLookups);
  const targetRecords = enrichScoreRecords(targetRecordsRaw, members);
  const expectRow = buildExpectedTargetRowForTarget(members, rules, targetId);

  let invalidScorerClauseKeys = new Set();
  let invalidExpectedRows = [expectRow];
  const needsInvalidCheck = (expectRow.expectedScorers || []).some((task) => task.requireAllComplete === true);
  if (needsInvalidCheck) {
    const allRecords = await getAllRecords(db.collection('score_records').where({ activityId }));
    invalidExpectedRows = await getExpectedTargetRows(activityId, members, rules);
    invalidScorerClauseKeys = calculateInvalidScorerClauseKeys(
      invalidExpectedRows,
      allRecords,
      createScorerKeyResolver(members)
    );
  }

  const payload = buildTargetRecordPayloadFromExpectRow(
    activityBrief,
    activityId,
    targetId,
    expectRow,
    targetRecords,
    invalidScorerClauseKeys,
    invalidExpectedRows
  );
  return buildTargetRecordsResponse(payload, targetId, offset);
}

function buildTargetRecordRows(targetId, expectedPairs = [], recordRows = []) {
  const targetRecordRows = [];
  const recordMap = new Map();
  recordRows
    .filter((record) => safeString(record.targetId) === targetId)
    .forEach((record) => {
      const key = safeString(record.scorerKey) || safeString(record.scorerId);
      if (key && !recordMap.has(key)) {
        recordMap.set(key, record);
      }
    });

  const expectedMap = new Map();
  expectedPairs
    .filter((task) => safeString(task.targetId) === targetId)
    .forEach((task) => {
      if (!expectedMap.has(task.scorerKey)) {
        expectedMap.set(task.scorerKey, task);
      }
    });

  expectedMap.forEach((task, scorerKey) => {
    const record = recordMap.get(scorerKey);
    if (record) {
      targetRecordRows.push({
        recordId: safeString(record.recordId),
        targetId,
        scorerKey,
        scorerId: safeString(record.scorerId),
        scorerName: safeString(record.scorerName),
        scorerStudentId: safeString(record.scorerStudentId),
        scorerDepartment: safeString(record.scorerDepartment),
        scorerIdentity: safeString(record.scorerIdentity),
        scorerWorkGroup: safeString(record.scorerWorkGroup),
        status: record.excludedByRequireAll ? 'inactive' : 'completed',
        statusText: record.excludedByRequireAll ? '评分未生效' : '已完成',
        submittedAt: safeString(record.submittedAt),
        excludedByRequireAll: record.excludedByRequireAll === true
      });
      return;
    }
    targetRecordRows.push({
      recordId: '',
      targetId,
      scorerKey,
      scorerId: safeString(task.scorerId),
      scorerName: safeString(task.scorerName),
      scorerStudentId: safeString(task.scorerStudentId),
      scorerDepartment: safeString(task.scorerDepartment),
      scorerIdentity: safeString(task.scorerIdentity),
      scorerWorkGroup: safeString(task.scorerWorkGroup || task.workGroup),
      status: 'pending',
      statusText: '未完成',
      submittedAt: '',
      excludedByRequireAll: false
    });
  });

  recordMap.forEach((record, scorerKey) => {
    if (expectedMap.has(scorerKey)) {
      return;
    }
    targetRecordRows.push({
      recordId: safeString(record.recordId),
      targetId,
      scorerKey,
      scorerId: safeString(record.scorerId),
      scorerName: safeString(record.scorerName),
      scorerStudentId: safeString(record.scorerStudentId),
      scorerDepartment: safeString(record.scorerDepartment),
      scorerIdentity: safeString(record.scorerIdentity),
      scorerWorkGroup: safeString(record.scorerWorkGroup),
      status: record.excludedByRequireAll ? 'inactive' : 'completed',
      statusText: record.excludedByRequireAll ? '评分未生效' : '已完成',
      submittedAt: safeString(record.submittedAt),
      excludedByRequireAll: record.excludedByRequireAll === true
    });
  });

  return targetRecordRows.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'pending' ? -1 : 1;
    }
    return String(a.scorerName || '').localeCompare(String(b.scorerName || ''), 'zh-CN');
  });
}

function buildTargetRecordsResponse(payload, targetId, offset) {
  const rows = buildTargetRecordRows(
    safeString(targetId),
    payload.expectedPairs || [],
    payload.recordRows || []
  );
  const basePayload = {
    status: 'success',
    activity: payload.activity || {},
    targetRecordRows: [],
    stats: payload.stats || {},
    pagination: {
      offset,
      nextOffset: offset,
      total: 0,
      hasMore: false,
      returnedCount: 0
    }
  };
  const pageResult = sliceRowsBySize(rows, offset, basePayload, 'targetRecordRows');
  basePayload.targetRecordRows = pageResult.rows;
  basePayload.pagination = {
    offset,
    nextOffset: pageResult.nextOffset,
    total: rows.length,
    hasMore: pageResult.hasMore,
    returnedCount: pageResult.rows.length
  };
  return basePayload;
}

function buildRecordDetail(record = {}) {
  const answers = Array.isArray(record.answers) ? record.answers : [];
  const templateScores = Array.isArray(record._computedTemplateScores) ? record._computedTemplateScores : [];
  const answerGroups = new Map();

  let cursor = 0;
  templateScores.forEach((template) => {
    const templateId = safeString(template.templateId);
    const questions = Array.isArray(template.questions) ? template.questions : [];
    const rows = [];
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index] || {};
      const globalIndex = cursor + index;
      const answer = answers.find((item, answerIndex) => toNumber(item.questionIndex, answerIndex) === globalIndex) || {};
      rows.push({
        questionIndex: index,
        question: safeString(question.question),
        scoreLabel: safeString(question.scoreLabel),
        minValue: toNumber(question.minValue, 0),
        maxValue: toNumber(question.maxValue, 0),
        stepValue: toNumber(question.stepValue, 0),
        score: toNumber(answer.score, 0)
      });
    }
    answerGroups.set(templateId, rows);
    cursor += questions.length;
  });

  return {
    recordId: safeString(record._id),
    scorer: {
      id: safeString(record.scorerId),
      name: safeString(record.scorerName),
      studentId: safeString(record.scorerStudentId),
      identity: safeString(record.scorerIdentity)
    },
    target: {
      id: safeString(record.targetId),
      name: safeString(record.targetName),
      studentId: safeString(record.targetStudentId),
      identity: safeString(record.targetIdentity)
    },
    submittedAt: formatDate(record.submittedAt),
    templates: templateScores.map((template) => {
      const templateId = safeString(template.templateId);
      return {
        templateId,
        templateName: safeString(template.templateName),
        weight: toNumber(template.weight, 0),
        score: roundScore(template.score),
        weightedScore: roundScore(template.weightedScore),
        questions: (answerGroups.get(templateId) || []).sort((a, b) => a.questionIndex - b.questionIndex)
      };
    })
  };
}

function buildRecordDetailResponse(records = [], recordId, rules = [], expectedPairs = [], resolveScorerKey = (record) => getScorerUniqueKey(record), orgLookups = {}) {
  const record = records.find((item) => safeString(item._id) === safeString(recordId));
  if (!record) {
    return {
      status: 'not_found',
      message: '未找到这条评分记录'
    };
  }
  const ruleById = new Map((rules || []).map((item) => [safeString(item._id), item]));
  const rule = ruleById.get(safeString(record.ruleId)) || {};
  const scorerKey = resolveScorerKey(record);
  const expectedTask = findExpectedPairTask(record, scorerKey, expectedPairs);
  const currentTemplates = getRecordTemplateScores(record, rule, expectedTask, orgLookups).map((template) => {
    const templateId = safeString(template.templateId);
    const config = findCurrentTemplateConfig(rule, expectedTask && expectedTask.clauseIndex, templateId, template);
    const weight = getCurrentTemplateWeight(rule, expectedTask && expectedTask.clauseIndex, templateId, template);
    const score = toNumber(template.score, 0);
    return {
      ...template,
      templateName: safeString(template.templateName),
      weight,
      weightedScore: score * weight
    };
  });
  return {
    status: 'success',
    recordDetail: buildRecordDetail({
      ...record,
      _computedTemplateScores: currentTemplates
    })
  };
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

exports.main = async (event) => {
  try {
    setTimezone(Number(event.timezone));
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const activityId = safeString(event.activityId);
    const filters = event.filters || {};
    const offset = Math.max(0, Math.floor(toNumber(event.offset, 0)));
    const dataType = safeString(event.dataType) || 'overview';
    const targetId = safeString(event.targetId);
    const recordId = safeString(event.recordId);
    const departmentName = safeString(event.departmentName);
    const scorerKey = safeString(event.scorerKey);

    if (!activityId) {
      return {
        status: 'invalid_params',
        message: '请先选择评分活动'
      };
    }

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return {
        status: 'forbidden',
        message: '没有管理权限'
      };
    }

    const normalizedDataType = dataType === 'record' ? 'records' : dataType;
    if (normalizedDataType === 'overview') {
      return handleOverviewRequest(activityId, filters, offset);
    }
    if (normalizedDataType === 'targetRecords') {
      return handleTargetRecordsRequest(activityId, targetId, offset);
    }
    if (normalizedDataType === 'completion') {
      return handleCompletionRequest(activityId, filters, offset, departmentName);
    }
    if (normalizedDataType === 'scorerTargets') {
      return handleScorerTargetsRequest(activityId, scorerKey);
    }

    const [activityRes, membersRaw, rulesRaw, recordsRaw, orgLookups] = await Promise.all([
      db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
      getAllRecords(db.collection('hr_info')),
      getAllRecords(db.collection('rate_target_rules').where({ activityId })),
      getAllRecords(db.collection('score_records').where({ activityId })),
      fetchOrgLookups()
    ]);

    if (!activityRes.data) {
      return {
        status: 'activity_not_found',
        message: '未找到对应的评分活动'
      };
    }

    const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
    const records = enrichScoreRecords(recordsRaw, members);
    const activityBrief = buildActivityBrief(activityRes.data);

    const hrMap = new Map(members.map((item) => [item.id, item]));
    const rules = normalizeRules(rulesRaw, orgLookups);
    const ruleById = new Map(rules.map((item) => [safeString(item._id), item]));

    const taskData = buildTaskData(members, rules, records);
    const resolveScorerKey = createScorerKeyResolver(members);
    const memberByScorerKey = new Map(members.map((member) => [getScorerUniqueKey(member), member]));
    const invalidScorerClauseKeys = new Set(taskData.invalidScorerClauseKeys || []);

    if (normalizedDataType === 'recordDetail') {
      if (!recordId) {
        return { status: 'invalid_params', message: '请选择要查看的评分记录' };
      }
      return buildRecordDetailResponse(records, recordId, rules, taskData.expectedPairs || [], resolveScorerKey, orgLookups);
    }

    const needsRecords = normalizedDataType === 'records';
    const needsDetail = normalizedDataType === 'detail';
    const needsCalculation = normalizedDataType === 'calculation';

    const calculationMap = new Map();
    const detailRows = [];
    const recordRows = [];

    records.forEach((record) => {
      const targetBase = buildTargetBase(record, hrMap);
      if (!targetBase.targetId) {
        return;
      }

      const rule = ruleById.get(safeString(record.ruleId)) || {};
      const scorerDepartment = safeString(rule.scorerDepartment);
      const scorerIdentity = safeString(rule.scorerIdentity);
      const scorerCategoryKey = `${scorerDepartment}::${scorerIdentity}`;
      const scorerCategoryLabel = [scorerDepartment, scorerIdentity].filter(Boolean).join(' / ') || '未匹配评分人类别';
      const resolvedScorerKey = resolveScorerKey(record);
      const expectedTask = findExpectedPairTask(record, resolvedScorerKey, taskData.expectedPairs || []);
      const scorerKey = safeString(
        (expectedTask || {}).scorerKey
        || resolvedScorerKey
        || record.scorerId
      );
      const scorerMember = memberByScorerKey.get(scorerKey) || {};
      const excludedByRequireAll = invalidScorerClauseKeys.has(
        findRecordScorerClauseKeyFromPairs(record, scorerKey, taskData.expectedPairs || [])
      );

      if (needsRecords) {
        const templateScores = getRecordTemplateScores(record, rule, expectedTask, orgLookups);
        const templateSummary = templateScores
          .map((item) => {
            const templateId = safeString(item.templateId);
            const currentConfig = findCurrentTemplateConfig(rule, expectedTask && expectedTask.clauseIndex, templateId, item);
            return `${safeString(currentConfig.templateName || item.templateName)} × ${getCurrentTemplateWeight(rule, expectedTask && expectedTask.clauseIndex, templateId, item)}`;
          })
          .filter(Boolean)
          .join('；');
        recordRows.push({
          recordId: safeString(record._id),
          activityId,
          activityName: safeString(activityRes.data.name),
          scorerKey,
          scorerId: safeString(record.scorerId),
          scorerName: safeString(record.scorerName),
          scorerStudentId: safeString(record.scorerStudentId),
          scorerDepartment,
          scorerIdentity,
          scorerWorkGroup: safeString(scorerMember.workGroup),
          scorerCategoryLabel,
          targetId: targetBase.targetId,
          name: targetBase.name,
          studentId: targetBase.studentId,
          department: targetBase.department,
          identity: targetBase.identity,
          workGroup: targetBase.workGroup || DEFAULT_WORK_GROUP,
          templateSummary,
          submittedAt: formatDate(record.submittedAt),
          excludedByRequireAll
        });
        return;
      }

      const templateScores = getRecordTemplateScores(record, rule, expectedTask, orgLookups);
      templateScores.forEach((templateItem) => {
        const templateId = safeString(templateItem.templateId);
        const currentConfig = findCurrentTemplateConfig(rule, expectedTask && expectedTask.clauseIndex, templateId, templateItem);
        const templateName = safeString(currentConfig.templateName || templateItem.templateName);
        const weight = getCurrentTemplateWeight(rule, expectedTask && expectedTask.clauseIndex, templateId, templateItem);
        const templateScore = toNumber(templateItem.score, 0);
        const weightedScore = roundScore(templateScore * weight);
        const groupKey = [targetBase.targetId, scorerCategoryKey, templateId].join('||');

        if (needsCalculation) {
          if (!calculationMap.has(groupKey)) {
            calculationMap.set(groupKey, {
              targetId: targetBase.targetId,
              name: targetBase.name,
              studentId: targetBase.studentId,
              department: targetBase.department,
              identity: targetBase.identity,
              workGroup: targetBase.workGroup || DEFAULT_WORK_GROUP,
              scorerDepartment,
              scorerIdentity,
              scorerCategoryKey,
              scorerCategoryLabel,
              templateId,
              templateName,
              weight,
              recordCount: 0,
              sumScore: 0
            });
          }

          if (!excludedByRequireAll) {
            const bucket = calculationMap.get(groupKey);
            bucket.recordCount += 1;
            bucket.sumScore += templateScore;
          }
        }

        if (needsDetail) {
          detailRows.push({
            ...targetBase,
            scorerId: safeString(record.scorerId),
            scorerName: safeString(record.scorerName),
            scorerStudentId: safeString(record.scorerStudentId),
            scorerDepartment,
            scorerIdentity,
            scorerCategoryLabel,
            ruleId: safeString(record.ruleId),
            recordId: safeString(record._id),
            templateId,
            templateName,
            weight,
            templateScore,
            weightedScore,
            submittedAt: formatDate(record.submittedAt),
            excludedByRequireAll
          });
        }
      });
    });

    const calculationRows = needsCalculation
      ? Array.from(calculationMap.values())
          .filter((item) => item.recordCount > 0)
          .map((item) => {
            const averageScore = item.recordCount ? item.sumScore / item.recordCount : 0;
            const contributionScore = averageScore * item.weight;
            return {
              targetId: item.targetId,
              name: item.name,
              studentId: item.studentId,
              department: item.department,
              identity: item.identity,
              workGroup: item.workGroup || DEFAULT_WORK_GROUP,
              scorerDepartment: item.scorerDepartment,
              scorerIdentity: item.scorerIdentity,
              scorerCategoryKey: item.scorerCategoryKey,
              scorerCategoryLabel: item.scorerCategoryLabel,
              templateId: item.templateId,
              templateName: item.templateName,
              weight: item.weight,
              recordCount: item.recordCount,
              averageScore: roundScore(averageScore),
              contributionScore: roundScore(contributionScore)
            };
          })
      : [];

    const sourceForFilters = needsRecords ? recordRows
      : needsDetail ? detailRows
      : calculationRows;

    const fullPayload = {
      status: 'success',
      activity: activityBrief,
      overviewRows: [],
      calculationRows,
      detailRows: needsDetail ? detailRows : [],
      recordRows: needsRecords ? recordRows : [],
      scorerCompletionRows: [],
      expectedPairs: [],
      scorerTaskRows: [],
      completionBoards: { departments: [] },

      stats: {
        totalMembers: sourceForFilters.length,
        scoredMembers: 0,
        recordCount: needsRecords ? recordRows.length : 0,
        calculationItemCount: needsCalculation ? calculationRows.length : 0,
        completedMembers: 0
      },

      filterOptions: {
        departments: Array.from(new Set(sourceForFilters.map((item) => item.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
        identities: Array.from(new Set(sourceForFilters.map((item) => item.identity).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
        workGroups: Array.from(new Set(sourceForFilters.map((item) => item.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
      }
    };

    return buildScoreResponseFromPayload(fullPayload, filters, normalizedDataType, offset);
    
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '获取评分结果失败'
    };
  }
};
