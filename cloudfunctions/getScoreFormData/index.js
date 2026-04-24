const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const RULE_SCOPE_LABEL_MAP = {
  same_department_identity: '同一部门内的指定身份成员',
  same_department_all: '同一部门内的所有成员',
  same_work_group_identity: '同一部门同一职能组内的指定身份成员',
  same_work_group_all: '同一部门同一职能组内的所有成员',
  identity_only: '全体成员中的指定身份',
  all_people: '全体成员'
};

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePerson(record = {}) {
  return {
    id: record._id || '',
    name: record.name || record['姓名'] || '',
    studentId: record.studentId || record['学号'] || '',
    identity: record.identity || record['身份'] || '',
    department: record.department || record['所属部门'] || '',
    workGroup: record.workGroup || record['工作分工（职能组）'] || '',
    adminLevel: record.adminLevel || ''
  };
}

function getRuleKey(person) {
  return `${person.department}::${person.identity}`;
}

function normalizeClause(clause = {}) {
  const templateConfigs = Array.isArray(clause.templateConfigs) && clause.templateConfigs.length
    ? clause.templateConfigs
    : (clause.templateId ? [{
      templateId: clause.templateId,
      templateName: clause.templateName || '',
      weight: clause.weight == null ? 1 : clause.weight,
      sortOrder: clause.sortOrder == null ? 1 : clause.sortOrder
    }] : []);

  return {
    scopeType: clause.scopeType || '',
    targetIdentity: clause.targetIdentity || '',
    templateConfigs: templateConfigs
      .map((item) => ({
        templateId: item.templateId || '',
        templateName: item.templateName || '',
        weight: Number(item.weight),
        sortOrder: Number(item.sortOrder)
      }))
      .filter((item) => item.templateId && Number.isFinite(item.weight) && item.weight > 0 && Number.isInteger(item.sortOrder) && item.sortOrder > 0)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  };
}

function getScopeLabel(value) {
  return RULE_SCOPE_LABEL_MAP[value] || value || '';
}

function buildTemplateConfigSignature(templateConfigs) {
  return (templateConfigs || [])
    .map((item) => `${item.templateId}@${item.weight}@${item.sortOrder}`)
    .join('|');
}

function isWorkGroupScope(scopeType) {
  return scopeType === 'same_work_group_identity' || scopeType === 'same_work_group_all';
}

async function fetchCurrentActivity() {
  const res = await db.collection('score_activities')
    .where({ isCurrent: true })
    .limit(1)
    .get();

  if (!res.data.length) {
    return null;
  }

  const item = res.data[0];
  return {
    id: item._id,
    name: item.name || '',
    description: item.description || '',
    startDate: item.startDate || '',
    endDate: item.endDate || ''
  };
}

async function fetchClauseTargets(scorer, clause) {
  const where = {};

  if (clause.scopeType === 'same_department_identity') {
    where['所属部门'] = scorer.department;
    where['身份'] = clause.targetIdentity;
  } else if (clause.scopeType === 'same_department_all') {
    where['所属部门'] = scorer.department;
  } else if (clause.scopeType === 'same_work_group_identity') {
    where['所属部门'] = scorer.department;
    where['工作分工（职能组）'] = scorer.workGroup;
    where['身份'] = clause.targetIdentity;
  } else if (clause.scopeType === 'same_work_group_all') {
    where['所属部门'] = scorer.department;
    where['工作分工（职能组）'] = scorer.workGroup;
  } else if (clause.scopeType === 'identity_only') {
    where['身份'] = clause.targetIdentity;
  } else if (clause.scopeType === 'all_people') {
    return db.collection('hr_info').limit(1000).get();
  } else {
    return { data: [] };
  }

  return db.collection('hr_info')
    .where(where)
    .limit(1000)
    .get();
}

async function collectCandidateRecords(scorer, openid, targetId, activityId) {
  const baseWhere = activityId ? { targetId, activityId } : { targetId, activityId: '' };
  const queries = [];

  if (openid) {
    queries.push({ ...baseWhere, openid });
  }
  if (scorer.studentId) {
    queries.push({ ...baseWhere, scorerStudentId: scorer.studentId });
  }
  if (scorer.id) {
    queries.push({ ...baseWhere, scorerId: scorer.id });
  }

  const recordMap = new Map();

  for (const where of queries) {
    const res = await db.collection('score_records')
      .where(where)
      .limit(1000)
      .get();

    (res.data || []).forEach((item) => {
      if (item && item._id && !recordMap.has(item._id)) {
        recordMap.set(item._id, item);
      }
    });
  }

  return Array.from(recordMap.values()).sort((a, b) => {
    const aTime = a && a.submittedAt && typeof a.submittedAt.toDate === 'function'
      ? a.submittedAt.toDate().getTime()
      : 0;
    const bTime = b && b.submittedAt && typeof b.submittedAt.toDate === 'function'
      ? b.submittedAt.toDate().getTime()
      : 0;
    return bTime - aTime;
  });
}

async function findExistingRecordAndCleanup(scorer, openid, targetId, activityId, templateConfigSignature) {
  const records = await collectCandidateRecords(scorer, openid, targetId, activityId);

  for (const record of records) {
    if (String(record.templateConfigSignature || '') === String(templateConfigSignature || '')) {
      return record;
    }

    await db.collection('score_records')
      .doc(record._id)
      .remove();
  }

  return null;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const targetId = String(event.targetId || '').trim();

  if (!targetId) {
    return {
      status: 'invalid_params',
      message: '缺少被评分人信息'
    };
  }

  const scorerRes = await db.collection('user_info')
    .where({ openid })
    .limit(1)
    .get();

  if (!scorerRes.data.length) {
    return {
      status: 'user_not_found',
      message: '未找到当前用户信息，请重新登录'
    };
  }

  const scorer = normalizePerson(scorerRes.data[0]);
  if (!scorer.department || !scorer.identity) {
    return {
      status: 'invalid_scorer',
      message: '当前用户缺少评分所需的人事信息'
    };
  }

  const activity = await fetchCurrentActivity();
  if (!activity) {
    return {
      status: 'missing_activity',
      message: '当前暂无评分活动'
    };
  }

  const ruleRes = await db.collection('rate_target_rules')
    .where({
      activityId: activity.id,
      scorerKey: getRuleKey(scorer),
      isActive: true
    })
    .limit(1)
    .get();

  if (!ruleRes.data.length) {
    return {
      status: 'missing_rule',
      message: '当前评分人类别尚未配置被评分人规则'
    };
  }

  const rule = ruleRes.data[0];
  const matchedClauseEntries = [];

  for (const rawClause of rule.clauses || []) {
    const clause = normalizeClause(rawClause);

    if (isWorkGroupScope(clause.scopeType) && !scorer.workGroup) {
      continue;
    }

    const res = await fetchClauseTargets(scorer, clause);
    const targetDoc = (res.data || []).find((item) => item._id === targetId);
    if (!targetDoc) {
      continue;
    }

    matchedClauseEntries.push({
      person: normalizePerson(targetDoc),
      clause
    });
  }

  if (!matchedClauseEntries.length) {
    return {
      status: 'target_not_allowed',
      message: '当前被评分人不在你的评分范围内'
    };
  }

  const targetEntry = matchedClauseEntries[0];
  const configuredClauseEntry = matchedClauseEntries.find((item) => Array.isArray(item.clause.templateConfigs) && item.clause.templateConfigs.length);

  if (!configuredClauseEntry) {
    return {
      status: 'missing_clause_config',
      message: '当前被评分人规则尚未配置评分问题，请联系管理员完善设置'
    };
  }

  const templateDocs = [];
  for (const config of configuredClauseEntry.clause.templateConfigs) {
    const templateRes = await db.collection('score_question_templates')
      .doc(config.templateId)
      .get();

    const templateDoc = templateRes.data;
    if (!templateDoc || !Array.isArray(templateDoc.questions) || !templateDoc.questions.length) {
      return {
        status: 'missing_template',
        message: '当前暂无评分问题，请联系管理员配置评分问题'
      };
    }

    templateDocs.push({
      id: templateDoc._id,
      name: templateDoc.name || config.templateName || '',
      description: templateDoc.description || '',
      weight: config.weight,
      sortOrder: config.sortOrder,
      questions: (templateDoc.questions || []).map((item, index) => ({
        id: `${templateDoc._id}_${index}`,
        questionIndex: index,
        question: item.question || '',
        scoreLabel: item.scoreLabel || '',
        minValue: toNumber(item.minValue, 0),
        startValue: toNumber(item.startValue, 0),
        maxValue: toNumber(item.maxValue, 0),
        stepValue: toNumber(item.stepValue, 0.5)
      }))
    });
  }

  const mergedQuestions = [];
  templateDocs
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .forEach((templateDoc) => {
      templateDoc.questions.forEach((question, index) => {
        mergedQuestions.push({
          id: `${templateDoc.id}_${index}`,
          templateId: templateDoc.id,
          templateName: templateDoc.name,
          templateWeight: templateDoc.weight,
          templateSortOrder: templateDoc.sortOrder,
          questionIndex: question.questionIndex,
          question: question.question,
          scoreLabel: question.scoreLabel,
          minValue: question.minValue,
          startValue: question.startValue,
          maxValue: question.maxValue,
          stepValue: question.stepValue
        });
      });
    });

  const templateConfigSignature = buildTemplateConfigSignature(configuredClauseEntry.clause.templateConfigs);
  const existingRecord = await findExistingRecordAndCleanup(
    scorer,
    openid,
    targetId,
    activity.id,
    templateConfigSignature
  );
  const answerMap = new Map(
    ((existingRecord && existingRecord.answers) || []).map((item) => [String(item.questionIndex), item.score])
  );

  return {
    status: 'success',
    scorer,
    target: targetEntry.person,
    currentActivity: activity,
    existingRecord: existingRecord ? {
      id: existingRecord._id,
      rawTotalScore: existingRecord.rawTotalScore,
      totalScore: existingRecord.weightedTotalScore,
      submittedAt: existingRecord.submittedAt || null
    } : null,
    rule: {
      id: rule._id,
      scorerDepartment: rule.scorerDepartment,
      scorerIdentity: rule.scorerIdentity,
      clauseScopeType: configuredClauseEntry.clause.scopeType,
      clauseScopeLabel: getScopeLabel(configuredClauseEntry.clause.scopeType),
      clauseTargetIdentity: configuredClauseEntry.clause.targetIdentity,
      templateConfigSignature
    },
    templateBundle: {
      name: templateDocs.map((item) => item.name).join(' + '),
      templates: templateDocs,
      questions: mergedQuestions.map((item, index, list) => ({
        ...item,
        startValue: toNumber(item.startValue, 0),
        stepValue: toNumber(item.stepValue, 0.5),
        showTemplateHeader: index === 0 || list[index - 1].templateId !== item.templateId,
        score: answerMap.has(String(index)) ? String(answerMap.get(String(index))) : ''
      }))
    }
  };
};
