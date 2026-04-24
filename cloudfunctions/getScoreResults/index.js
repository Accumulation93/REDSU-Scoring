const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const FIELD_NAME = '姓名';
const FIELD_STUDENT_ID = '学号';
const FIELD_DEPARTMENT = '所属部门';
const FIELD_IDENTITY = '身份';
const FIELD_WORK_GROUP = '工作分工（职能组）';
const DEFAULT_WORK_GROUP = '未分组';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundScore(value) {
  return Number(toNumber(value, 0).toFixed(3));
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
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
  const timePart = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ].join(':');
  return `${datePart} ${timePart}`;
}

function normalizeMember(record = {}) {
  return {
    id: safeString(record._id),
    name: safeString(record.name || record[FIELD_NAME]),
    studentId: safeString(record.studentId || record[FIELD_STUDENT_ID]),
    department: safeString(record.department || record[FIELD_DEPARTMENT]),
    identity: safeString(record.identity || record[FIELD_IDENTITY]),
    workGroup: safeString(record.workGroup || record[FIELD_WORK_GROUP]) || DEFAULT_WORK_GROUP
  };
}

function getMemberRuleKey(member = {}) {
  return `${safeString(member.department)}::${safeString(member.identity)}`;
}

function getScorerUniqueKey(memberOrRecord = {}) {
  return safeString(memberOrRecord.scorerStudentId || memberOrRecord.studentId)
    || safeString(memberOrRecord.scorerId || memberOrRecord.id);
}

function createScorerKeyResolver(members = []) {
  const aliasMap = new Map();

  members.forEach((member) => {
    const canonicalKey = getScorerUniqueKey(member);

    [
      member.id,
      member.studentId,
      member.scorerId,
      member.scorerStudentId
    ].forEach((value) => {
      const key = safeString(value);
      if (key) {
        aliasMap.set(key, canonicalKey);
      }
    });
  });

  return function resolveScorerKey(record = {}) {
    const rawKeys = [
      record.scorerStudentId,
      record.studentId,
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

function normalizeRuleClause(rawClause = {}) {
  return {
    scopeType: safeString(rawClause.scopeType),
    targetIdentity: safeString(rawClause.targetIdentity),
    requireAllComplete: rawClause.requireAllComplete === true,
    templateConfigs: Array.isArray(rawClause.templateConfigs)
      ? rawClause.templateConfigs
        .map((item) => ({
          templateId: safeString(item.templateId),
          templateName: safeString(item.templateName),
          weight: toNumber(item.weight, 0),
          sortOrder: toNumber(item.sortOrder, 0)
        }))
        .filter((item) => item.templateId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
      : []
  };
}

function matchesClauseTarget(target, scorer, clause) {
  if (clause.scopeType === 'same_department_identity') {
    return target.department === scorer.department && target.identity === clause.targetIdentity;
  }
  if (clause.scopeType === 'same_department_all') {
    return target.department === scorer.department;
  }
  if (clause.scopeType === 'same_work_group_identity') {
    return target.department === scorer.department
      && target.workGroup === scorer.workGroup
      && target.identity === clause.targetIdentity;
  }
  if (clause.scopeType === 'same_work_group_all') {
    return target.department === scorer.department && target.workGroup === scorer.workGroup;
  }
  if (clause.scopeType === 'identity_only') {
    return target.identity === clause.targetIdentity;
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
    name: target ? target.name : safeString(record.targetName),
    studentId: target ? target.studentId : safeString(record.targetStudentId),
    department: target ? target.department : safeString(record.targetDepartment),
    identity: target ? target.identity : safeString(record.targetIdentity),
    workGroup: target ? target.workGroup : (safeString(record.targetWorkGroup) || DEFAULT_WORK_GROUP)
  };
}

function buildCompletionBoard(rows, field) {
  const boardMap = new Map();
  rows.filter((item) => Number(item.expectedCount || 0) > 0).forEach((item) => {
    const key = safeString(item[field]) || '未设置';
    if (!boardMap.has(key)) {
      boardMap.set(key, {
        groupName: key,
        memberCount: 0,
        completedCount: 0,
        pendingCount: 0,
        scorerRows: []
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
  });

  return Array.from(boardMap.values())
    .map((item) => ({
      ...item,
      completionRate: item.memberCount
        ? Number(((item.completedCount / item.memberCount) * 100).toFixed(2))
        : 100,
      scorerRows: item.scorerRows.sort((a, b) => {
        const pendingDiff = Number(b.pendingCount || 0) - Number(a.pendingCount || 0);
        if (pendingDiff !== 0) {
          return pendingDiff;
        }
        return String(a.scorerName || '').localeCompare(String(b.scorerName || ''), 'zh-CN');
      })
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
    const scorers = membersByRuleKey.get(rule.scorerKey) || [];
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
        pendingScorerNames: []
      });
    }
    const targetStat = targetPendingMap.get(task.targetId);
    targetStat.expectedScorerKeys.add(task.scorerKey);
    targetStat.pendingScorerNames.push(task.scorerName);
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
    targetStat.pendingScorerNames = targetStat.pendingScorerNames.filter((name, index) => {
      const scorerKey = Array.from(targetStat.expectedScorerKeys)[index];
      return scorerKey && !targetStat.submittedScorerKeys.has(scorerKey);
    });
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
    invalidScorerClauseKeys
  };
}

function applyFiltersToRows(payload, filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);
  const isAll = (value) => !value || value === '全部';

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
    ...payload,
    overviewRows,
    calculationRows,
    detailRows,
    recordRows,
    scorerCompletionRows,
    completionBoards: {
      departments: buildCompletionBoard(scorerCompletionRows, 'department'),
      identities: [],
      workGroups: []
    },
    stats: {
      totalMembers: overviewRows.length,
      scoredMembers: overviewRows.filter((item) => Number(item.finalScore || 0) > 0).length,
      recordCount: recordRows.length,
      calculationItemCount: calculationRows.length,
      completedMembers: scorerCompletionRows.filter((item) => Number(item.pendingCount || 0) === 0).length
    }
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
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const activityId = safeString(event.activityId);
  const filters = event.filters || {};

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

  const [activityRes, hrRes, ruleRes, recordRes] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    db.collection('hr_info').limit(1000).get(),
    db.collection('rate_target_rules').where({ activityId }).limit(1000).get(),
    db.collection('score_records').where({ activityId }).limit(1000).get()
  ]);

  if (!activityRes.data) {
    return {
      status: 'activity_not_found',
      message: '未找到对应的评分活动'
    };
  }

  const members = (hrRes.data || []).map((item) => normalizeMember(item));
  const hrMap = new Map(members.map((item) => [item.id, item]));
  const rules = (ruleRes.data || []).map((item) => ({
    ...item,
    scorerKey: safeString(item.scorerKey),
    scorerDepartment: safeString(item.scorerDepartment),
    scorerIdentity: safeString(item.scorerIdentity),
    clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause)) : []
  }));
  const records = recordRes.data || [];
  const ruleById = new Map(rules.map((item) => [safeString(item._id), item]));

  const taskData = buildTaskData(members, rules, records);
  const resolveScorerKey = createScorerKeyResolver(members);
  const scorerTaskRowMap = new Map((taskData.scorerTaskRows || []).map((item) => [item.scorerKey, item]));
  const scorerCompletionRows = members.map((member) => {
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
  const invalidRuleScorerPairs = new Set();
  taskData.invalidScorerClauseKeys.forEach((key) => {
    const parts = key.split('::');
    const ruleId = parts[0];
    const scorerKey = parts.slice(2).join('::');
    invalidRuleScorerPairs.add(`${ruleId}::${scorerKey}`);
  });

  const calculationMap = new Map();
  const memberScoreMap = new Map();
  const detailRows = [];
  const recordRows = [];
  const targetSubmittedScorerKeyMap = new Map();

  records.forEach((record) => {
    const targetBase = buildTargetBase(record, hrMap);
    if (!targetBase.targetId) {
      return;
    }

    const rule = ruleById.get(safeString(record.ruleId)) || {};
    const scorerDepartment = safeString(rule.scorerDepartment);
    const scorerIdentity = safeString(rule.scorerIdentity || record.scorerIdentity);
    const scorerCategoryKey = `${scorerDepartment}::${scorerIdentity}`;
    const scorerCategoryLabel = [scorerDepartment, scorerIdentity].filter(Boolean).join(' / ') || '未匹配评分人类别';
    const templateScores = Array.isArray(record.templateScores) ? record.templateScores : [];
    const templateSummary = templateScores
      .map((item) => `${safeString(item.templateName)} × ${toNumber(item.weight, 0)}`)
      .filter(Boolean)
      .join('；');
    const scorerKey = resolveScorerKey(record);
    const excludedByRequireAll = invalidRuleScorerPairs.has(`${safeString(record.ruleId)}::${scorerKey}`);

    if (!excludedByRequireAll && scorerKey) {
      if (!targetSubmittedScorerKeyMap.has(targetBase.targetId)) {
        targetSubmittedScorerKeyMap.set(targetBase.targetId, new Set());
      }
      targetSubmittedScorerKeyMap.get(targetBase.targetId).add(scorerKey);
    }

    recordRows.push({
      recordId: safeString(record._id),
      activityId,
      activityName: safeString(activityRes.data.name),
      scorerId: safeString(record.scorerId),
      scorerName: safeString(record.scorerName),
      scorerStudentId: safeString(record.scorerStudentId),
      scorerDepartment,
      scorerIdentity,
      scorerCategoryLabel,
      targetId: targetBase.targetId,
      name: targetBase.name,
      studentId: targetBase.studentId,
      department: targetBase.department,
      identity: targetBase.identity,
      workGroup: targetBase.workGroup || DEFAULT_WORK_GROUP,
      templateSummary,
      rawTotalScore: toNumber(record.rawTotalScore, 0),
      weightedTotalScore: roundScore(record.weightedTotalScore),
      submittedAt: formatDate(record.submittedAt),
      excludedByRequireAll
    });

    templateScores.forEach((templateItem) => {
      const templateId = safeString(templateItem.templateId);
      const templateName = safeString(templateItem.templateName);
      const weight = toNumber(templateItem.weight, 0);
      const templateScore = toNumber(templateItem.score, 0);
      const weightedScore = roundScore(toNumber(templateItem.weightedScore, templateScore * weight));
      const groupKey = [targetBase.targetId, scorerCategoryKey, templateId].join('||');

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
        finalRecordScore: roundScore(record.weightedTotalScore),
        submittedAt: formatDate(record.submittedAt),
        excludedByRequireAll
      });
    });
  });

  const calculationRows = Array.from(calculationMap.values())
    .filter((item) => item.recordCount > 0)
    .map((item) => {
      const averageScore = item.recordCount ? item.sumScore / item.recordCount : 0;
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
    });

  const overviewRows = members.map((member) => {
    const scoreStat = memberScoreMap.get(member.id) || {};
    const pendingStat = taskData.targetPendingMap.get(member.id) || {
      expectedScorerKeys: new Set(),
      submittedScorerKeys: new Set(),
      pendingScorerNames: []
    };
    const submittedByRecords = (targetSubmittedScorerKeyMap.get(member.id) || new Set()).size;
    const expectedScorerCount = Math.max(pendingStat.expectedScorerKeys.size, submittedByRecords);
    const submittedScorerCount = submittedByRecords;
    const pendingScorerCount = Math.max(expectedScorerCount - submittedScorerCount, 0);
    return {
      id: member.id,
      name: member.name,
      studentId: member.studentId,
      department: member.department,
      identity: member.identity,
      workGroup: member.workGroup || DEFAULT_WORK_GROUP,
      finalScore: roundScore(scoreStat.finalScore),
      scoredRecordCount: toNumber(scoreStat.scoredRecordCount, 0),
      scoredTemplateCount: toNumber(scoreStat.scoredTemplateCount, 0),
      expectedScorerCount,
      submittedScorerCount,
      pendingScorerCount,
      completionRate: expectedScorerCount
        ? Number(((submittedScorerCount / expectedScorerCount) * 100).toFixed(2))
        : 0,
      pendingScorerNames: (pendingStat.pendingScorerNames || []).join('、')
    };
  });

  const payload = {
    status: 'success',
    activity: {
      id: activityRes.data._id,
      name: safeString(activityRes.data.name),
      description: safeString(activityRes.data.description)
    },
    overviewRows,
    calculationRows,
    detailRows,
    recordRows,
    completionBoards: {
      departments: buildCompletionBoard(scorerCompletionRows, 'department'),
      identities: [],
      workGroups: []
    },
    scorerTaskRows: taskData.scorerTaskRows,
    scorerCompletionRows,
    stats: {
      totalMembers: overviewRows.length,
      scoredMembers: overviewRows.filter((item) => Number(item.finalScore || 0) > 0).length,
      recordCount: recordRows.length,
      calculationItemCount: calculationRows.length,
      completedMembers: scorerCompletionRows.filter((item) => Number(item.pendingCount || 0) === 0).length
    },
    filterOptions: {
      departments: Array.from(new Set(overviewRows.map((item) => item.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      identities: Array.from(new Set(overviewRows.map((item) => item.identity).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      workGroups: Array.from(new Set(overviewRows.map((item) => item.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    }
  };

  return applyFiltersToRows(payload, filters);
};

