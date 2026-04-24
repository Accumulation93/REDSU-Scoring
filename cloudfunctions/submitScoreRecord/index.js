const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePerson(record) {
  return {
    id: record._id || '',
    name: record.name || record['姓名'] || '',
    studentId: record.studentId || record['学号'] || '',
    identity: record.identity || record['身份'] || '',
    department: record.department || record['所属部门'] || '',
    workGroup: record.workGroup || record['工作分工（职能组）'] || ''
  };
}

function getRuleKey(person) {
  return `${person.department}::${person.identity}`;
}

function isStepAligned(value, startValue, stepValue) {
  if (!Number.isFinite(stepValue) || stepValue <= 0) {
    return true;
  }

  const diff = (value - startValue) / stepValue;
  return Math.abs(diff - Math.round(diff)) < 1e-8;
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

function buildTemplateConfigSignature(templateConfigs) {
  return templateConfigs
    .map((item) => `${item.templateId}@${item.weight}@${item.sortOrder}`)
    .join('|');
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

async function fetchFirstMatchingRecord(where) {
  const res = await db.collection('score_records')
    .where(where)
    .limit(1)
    .get();

  return res.data.length ? res.data[0] : null;
}

async function fetchExistingRecord(scorer, openid, targetId, activityId) {
  const baseWhere = {
    targetId,
    activityId
  };

  const queries = [];

  if (openid) {
    queries.push({
      ...baseWhere,
      openid
    });
  }

  if (scorer.studentId) {
    queries.push({
      ...baseWhere,
      scorerStudentId: scorer.studentId
    });
  }

  if (scorer.id) {
    queries.push({
      ...baseWhere,
      scorerId: scorer.id
    });
  }

  for (const where of queries) {
    const record = await fetchFirstMatchingRecord(where);
    if (record) {
      return record;
    }
  }

  return null;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const targetId = String(event.targetId || '').trim();
  const activityId = String(event.activityId || '').trim();
  const activityName = String(event.activityName || '').trim();
  const templateConfigSignature = String(event.templateConfigSignature || '').trim();
  const answers = Array.isArray(event.answers) ? event.answers : [];

  if (!targetId || !templateConfigSignature || !answers.length) {
    return {
      status: 'invalid_params',
      message: '评分信息不完整'
    };
  }

  const scorerRes = await db.collection('user_info')
    .where({ openid })
    .limit(1)
    .get();

  if (!scorerRes.data.length) {
    return {
      status: 'user_not_found',
      message: '未找到当前评分人'
    };
  }

  const scorer = normalizePerson(scorerRes.data[0]);
  const targetRes = await db.collection('hr_info').doc(targetId).get();
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

  for (const rawClause of rule.clauses || []) {
    const clause = normalizeClause(rawClause);
    if (!clause.templateConfigs.length) {
      continue;
    }

    if ((clause.scopeType === 'same_work_group_identity' || clause.scopeType === 'same_work_group_all') && !scorer.workGroup) {
      continue;
    }

    const res = await fetchClauseTargets(scorer, clause);
    (res.data || []).forEach((item) => {
      allowedTargetIds.add(item._id);
      if (item._id === targetId && !matchedClause) {
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

  if (buildTemplateConfigSignature(matchedClause.templateConfigs) !== templateConfigSignature) {
    return {
      status: 'template_mismatch',
      message: '评分模板配置已变更，请重新进入评分页'
    };
  }

  const questionBundle = [];
  const templateScores = [];

  for (const config of matchedClause.templateConfigs) {
    const templateRes = await db.collection('score_question_templates').doc(config.templateId).get();
    const templateDoc = templateRes.data;

    if (!templateDoc || !Array.isArray(templateDoc.questions) || !templateDoc.questions.length) {
      return {
        status: 'missing_template',
        message: '当前评分模板不存在'
      };
    }

    const questions = (templateDoc.questions || []).map((question, questionIndex) => ({
      templateId: templateDoc._id,
      templateName: templateDoc.name || config.templateName || '',
      templateWeight: config.weight,
      templateSortOrder: config.sortOrder,
      questionIndex,
      question: question.question || '',
      scoreLabel: question.scoreLabel || '',
      minValue: toNumber(question.minValue, 0),
      startValue: toNumber(question.startValue, 0),
      maxValue: toNumber(question.maxValue, 0),
      stepValue: toNumber(question.stepValue, 0.5)
    }));

    templateScores.push({
      templateId: templateDoc._id,
      templateName: templateDoc.name || config.templateName || '',
      weight: config.weight,
      sortOrder: config.sortOrder,
      score: 0
    });

    questionBundle.push(...questions);
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
  let rawTotalScore = 0;

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

    rawTotalScore += score;
    normalizedAnswers.push({
      questionIndex: i,
      templateId: question.templateId,
      templateName: question.templateName,
      templateWeight: question.templateWeight,
      templateSortOrder: question.templateSortOrder,
      templateQuestionIndex: question.questionIndex,
      question: question.question,
      scoreLabel: question.scoreLabel,
      minValue: question.minValue,
      startValue: question.startValue,
      maxValue: question.maxValue,
      stepValue: question.stepValue,
      score
    });

    const targetTemplateScore = templateScores.find((item) => item.templateId === question.templateId);
    if (targetTemplateScore) {
      targetTemplateScore.score += score;
    }
  }

  const weightedTotalScore = templateScores.reduce((sum, item) => sum + (item.score * item.weight), 0);
  const finalizedTemplateScores = templateScores.map((item) => ({
    ...item,
    weightedScore: item.score * item.weight
  }));

  const record = {
    activityId,
    activityName,
    ruleId: rule._id,
    templateConfigSignature,
    templateConfigs: matchedClause.templateConfigs,
    templateDisplayName: finalizedTemplateScores.map((item) => item.templateName).join(' + '),
    scorerId: scorer.id,
    scorerOpenId: openid,
    scorerName: scorer.name,
    scorerStudentId: scorer.studentId,
    scorerIdentity: scorer.identity,
    targetId: targetDoc._id,
    targetName: targetDoc['姓名'] || '',
    targetStudentId: targetDoc['学号'] || '',
    targetIdentity: targetDoc['身份'] || '',
    answers: normalizedAnswers,
    templateScores: finalizedTemplateScores,
    rawTotalScore,
    weightedTotalScore,
    submittedAt: db.serverDate(),
    openid
  };

  const existingRecord = await fetchExistingRecord(scorer, openid, targetDoc._id, activityId);
  let recordId = '';

  if (existingRecord) {
    recordId = existingRecord._id;
    await db.collection('score_records').doc(recordId).update({
      data: record
    });
  } else {
    const addRes = await db.collection('score_records').add({
      data: record
    });
    recordId = addRes._id;
  }

  return {
    status: 'success',
    recordId,
    totalScore: weightedTotalScore,
    rawTotalScore
  };
};
