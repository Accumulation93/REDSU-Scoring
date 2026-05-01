const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 100;

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function getAllRecords(query) {
  const list = [];
  let skip = 0;
  while (true) {
    const res = await query.where({}).skip(skip).limit(PAGE_SIZE).get().catch(() => ({ data: [] }));
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }
  return list;
}

function buildNameMap(rows = []) {
  const map = new Map();
  rows.forEach((item) => {
    const id = safeString(item && item._id);
    if (id) map.set(id, safeString(item.name));
  });
  return map;
}

async function fetchOrgLookups() {
  const [departments, identities, workGroups] = await Promise.all([
    getAllRecords(db.collection('departments')),
    getAllRecords(db.collection('identities')),
    getAllRecords(db.collection('work_groups'))
  ]);
  return {
    departmentsById: buildNameMap(departments),
    identitiesById: buildNameMap(identities),
    workGroupsById: buildNameMap(workGroups)
  };
}

function isStepAligned(score, startValue, stepValue) {
  const step = toNumber(stepValue, 0);
  if (!step) return true;
  const diff = (toNumber(score, 0) - toNumber(startValue, 0)) / step;
  return Math.abs(diff - Math.round(diff)) < 1e-8;
}

function getRuleKey(person) {
  const departmentId = String(person.departmentId || '').trim();
  const identityId = String(person.identityId || '').trim();
  return departmentId && identityId ? departmentId + '::' + identityId : '';
}

function normalizeHrPerson(record = {}, orgLookups = {}) {
  const departmentId = String(record.departmentId || '').trim();
  const identityId = String(record.identityId || '').trim();
  const workGroupId = String(record.workGroupId || '').trim();
  return {
    id: record._id || '',
    name: String(record.name || '').trim(),
    studentId: String(record.studentId || '').trim(),
    identityId,
    identity: String((orgLookups.identitiesById && orgLookups.identitiesById.get(identityId)) || '').trim(),
    departmentId,
    department: String((orgLookups.departmentsById && orgLookups.departmentsById.get(departmentId)) || '').trim(),
    workGroupId,
    workGroup: String((orgLookups.workGroupsById && orgLookups.workGroupsById.get(workGroupId)) || '').trim()
  };
}

function normalizeClause(clause = {}) {
  const templateConfigs = Array.isArray(clause.templateConfigs) && clause.templateConfigs.length
    ? clause.templateConfigs
    : (clause.templateId ? [{
      templateId: clause.templateId,
      weight: clause.weight == null ? 1 : clause.weight,
      sortOrder: clause.sortOrder == null ? 1 : clause.sortOrder
    }] : []);

  return {
    scopeType: clause.scopeType || '',
    targetIdentityId: clause.targetIdentityId || '',
    targetIdentity: '',
    templateConfigs: templateConfigs
      .map((item) => ({
        templateId: item.templateId || '',
        weight: Number(item.weight),
        sortOrder: Number(item.sortOrder)
      }))
      .filter((item) => item.templateId && Number.isFinite(item.weight) && item.weight > 0 && Number.isInteger(item.sortOrder) && item.sortOrder > 0)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  };
}

function buildTemplateConfigSignature(templateConfigs, templatesById) {
  return (templateConfigs || [])
    .map((config) => {
      const template = templatesById && templatesById.get(safeString(config.templateId));
      if (!template || !Array.isArray(template.questions) || !template.questions.length) return '';
      const qSig = template.questions
        .map((q) => [
          toNumber(q.minValue, 0),
          toNumber(q.startValue, 0),
          toNumber(q.maxValue, 0),
          toNumber(q.stepValue, 0.5)
        ].join(':'))
        .join(',');
      return `${safeString(config.templateId)}[${qSig}]`;
    })
    .filter(Boolean)
    .join('|');
}

function normalizeTemplateConfigSignature(signature = '') {
  return String(signature || '').trim();
}

function stripTemplateConfigWeight(config = {}) {
  return {
    templateId: safeString(config.templateId),
    weight: toNumber(config.weight, 0),
    sortOrder: toNumber(config.sortOrder, 0)
  };
}

async function fetchClauseTargets(scorer, clause) {
  const where = {};
  if (clause.scopeType === 'same_department_identity') {
    where.departmentId = scorer.departmentId;
    where.identityId = clause.targetIdentityId;
  } else if (clause.scopeType === 'same_department_all') {
    where.departmentId = scorer.departmentId;
  } else if (clause.scopeType === 'same_work_group_identity') {
    where.departmentId = scorer.departmentId;
    where.workGroupId = scorer.workGroupId;
    where.identityId = clause.targetIdentityId;
  } else if (clause.scopeType === 'same_work_group_all') {
    where.departmentId = scorer.departmentId;
    where.workGroupId = scorer.workGroupId;
  } else if (clause.scopeType === 'identity_only') {
    where.identityId = clause.targetIdentityId;
  } else if (clause.scopeType === 'all_people') {
    return db.collection('hr_info').limit(1000).get();
  } else {
    return { data: [] };
  }
  return db.collection('hr_info').where(where).limit(1000).get();
}

async function fetchClauseTargetsByNormalizedFields(scorer, clause, members = null, orgLookups = {}) {
  const source = Array.isArray(members) ? members : ((await db.collection('hr_info').limit(1000).get()).data || []);
  const data = source.filter((item) => {
    const target = normalizeHrPerson(item, orgLookups);
    if (clause.scopeType === 'same_department_identity') return target.departmentId === scorer.departmentId && target.identityId === clause.targetIdentityId;
    if (clause.scopeType === 'same_department_all') return target.departmentId === scorer.departmentId;
    if (clause.scopeType === 'same_work_group_identity') return target.departmentId === scorer.departmentId && target.workGroupId === scorer.workGroupId && target.identityId === clause.targetIdentityId;
    if (clause.scopeType === 'same_work_group_all') return target.departmentId === scorer.departmentId && target.workGroupId === scorer.workGroupId;
    if (clause.scopeType === 'identity_only') return target.identityId === clause.targetIdentityId;
    if (clause.scopeType === 'all_people') return true;
    return false;
  });
  return { data };
}

async function fetchExistingRecord(scorer, openid, targetId, activityId) {
  if (!scorer.id || !targetId || !activityId) return null;
  const res = await db.collection('score_records')
    .where({ scorerId: scorer.id, targetId, activityId })
    .limit(1)
    .get();
  return res.data.length ? res.data[0] : null;
}

exports.main = async (event) => {
  const targetId = String(event.targetId || '').trim();
  const activityId = String(event.activityId || '').trim();
  const templateConfigSignature = String(event.templateConfigSignature || '').trim();
  const answers = Array.isArray(event.answers) ? event.answers : [];
  const scorerId = String(event.scorerId || '').trim();

  if (!scorerId || !targetId || !templateConfigSignature || !answers.length) {
    return {
      status: 'invalid_params',
      message: '评分信息不完整'
    };
  }

  const [orgLookups, hrRes, targetRes] = await Promise.all([
    fetchOrgLookups(),
    db.collection('hr_info').doc(scorerId).get().catch(() => ({ data: null })),
    db.collection('hr_info').doc(targetId).get().catch(() => ({ data: null }))
  ]);

  if (!hrRes.data) {
    return {
      status: 'invalid_scorer',
      message: '当前评分人信息不存在，请重新登录'
    };
  }

  const scorer = normalizeHrPerson(hrRes.data, orgLookups);
  const targetDoc = targetRes.data;

  if (!targetDoc) {
    return {
      status: 'target_not_found',
      message: '未找到被评分人'
    };
  }

  if (!activityId) {
    return {
      status: 'invalid_params',
      message: '缺少评分活动信息'
    };
  }

  const ruleRes = await db.collection('rate_target_rules')
    .where({
      activityId,
      scorerKey: getRuleKey(scorer),
      isActive: true
    })
    .limit(1)
    .get();

  if (!ruleRes.data.length) {
    return {
      status: 'missing_rule',
      message: '当前评分规则不存在'
    };
  }

  const rule = ruleRes.data[0];
  let matchedClause = null;
  const allowedTargetIds = new Set();
  const allHrMembers = (await db.collection('hr_info').limit(1000).get()).data || [];

  for (const rawClause of rule.clauses || []) {
    const clause = normalizeClause(rawClause);
    if (!clause.templateConfigs.length) {
      continue;
    }

    if ((clause.scopeType === 'same_work_group_identity' || clause.scopeType === 'same_work_group_all') && !scorer.workGroupId) {
      continue;
    }

    const res = await fetchClauseTargetsByNormalizedFields(scorer, clause, allHrMembers, orgLookups);
    (res.data || []).forEach((item) => {
      allowedTargetIds.add(item._id);
      if (item._id === targetId && (!matchedClause || !matchedClause.templateConfigs.length)) {
        matchedClause = clause;
      }
    });
  }

  if (!allowedTargetIds.has(targetId)) {
    return {
      status: 'target_not_allowed',
      message: '当前被评分人不在你的评分范围内'
    };
  }

  if (!matchedClause) {
    return {
      status: 'missing_rule',
      message: '未匹配到当前评分规则子句'
    };
  }

  // 先拉取所有模板数据，用于构建新的结构签名和后续校验
  const templatesById = new Map();
  const questionBundle = [];
  for (const config of matchedClause.templateConfigs) {
    const templateRes = await db.collection('score_question_templates').doc(config.templateId).get();
    const templateDoc = templateRes.data;

    if (!templateDoc || !Array.isArray(templateDoc.questions) || !templateDoc.questions.length) {
      return {
        status: 'missing_template',
        message: '当前评分模板不存在'
      };
    }

    templatesById.set(safeString(config.templateId), templateDoc);

    const questions = (templateDoc.questions || []).map((question, questionIndex) => ({
      templateId: templateDoc._id,
      templateSortOrder: config.sortOrder,
      questionIndex,
      question: question.question || '',
      scoreLabel: question.scoreLabel || '',
      minValue: toNumber(question.minValue, 0),
      startValue: toNumber(question.startValue, 0),
      maxValue: toNumber(question.maxValue, 0),
      stepValue: toNumber(question.stepValue, 0.5)
    }));

    questionBundle.push(...questions);
  }

  // 基于模板实际题目结构构建签名并校验
  if (buildTemplateConfigSignature(matchedClause.templateConfigs, templatesById) !== normalizeTemplateConfigSignature(templateConfigSignature)) {
    return {
      status: 'template_mismatch',
      message: '评分模板配置已变更，请重新进入评分页'
    };
  }

  questionBundle.sort((a, b) => {
    if (a.templateSortOrder !== b.templateSortOrder) {
      return a.templateSortOrder - b.templateSortOrder;
    }
    return a.questionIndex - b.questionIndex;
  });

  const answerMap = new Map(
    answers.map((item) => [String(item.questionIndex), Number(item.score)])
  );

  const normalizedAnswers = [];

  for (let i = 0; i < questionBundle.length; i += 1) {
    const question = questionBundle[i];
    const score = answerMap.get(String(i));

    if (score == null || Number.isNaN(score)) {
      return {
        status: 'invalid_score',
        message: `第 ${i + 1} 题未填写`
      };
    }

    if (score < question.minValue || score > question.maxValue) {
      return {
        status: 'invalid_score',
        message: `第 ${i + 1} 题超出分值范围`
      };
    }

    if (!isStepAligned(score, question.startValue, question.stepValue)) {
      return {
        status: 'invalid_score',
        message: `第 ${i + 1} 题不符合起评分和步进值要求`
      };
    }

    normalizedAnswers.push({
      questionIndex: i,
      score
    });
  }

  const record = {
    activityId,
    ruleId: rule._id,
    templateConfigSignature,
    scorerId: scorer.id,
    targetId: targetDoc._id,
    answers: normalizedAnswers,
    submittedAt: db.serverDate()
  };

  const existingRecord = await fetchExistingRecord(scorer, null, targetDoc._id, activityId);
  let recordId = '';

  if (existingRecord) {
    recordId = existingRecord._id;
    await db.collection('score_records').doc(recordId).update({
      data: {
        ...record,
        activityName: _.remove(),
        templateConfigs: _.remove(),
        openid: _.remove(),
        templateDisplayName: _.remove(),
        templateScores: _.remove(),
        scorerOpenId: _.remove(),
        scorerName: _.remove(),
        scorerStudentId: _.remove(),
        scorerDepartmentId: _.remove(),
        scorerDepartment: _.remove(),
        scorerIdentityId: _.remove(),
        scorerIdentity: _.remove(),
        scorerWorkGroupId: _.remove(),
        scorerWorkGroup: _.remove(),
        targetName: _.remove(),
        targetStudentId: _.remove(),
        targetDepartmentId: _.remove(),
        targetDepartment: _.remove(),
        targetIdentityId: _.remove(),
        targetIdentity: _.remove(),
        targetWorkGroupId: _.remove(),
        targetWorkGroup: _.remove()
      }
    });
  } else {
    const addRes = await db.collection('score_records').add({
      data: record
    });
    recordId = addRes._id;
  }

  return {
    status: 'success',
    recordId
  };
};
