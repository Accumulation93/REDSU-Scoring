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

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeClause(clause = {}) {
  const templateConfigs = Array.isArray(clause.templateConfigs) ? clause.templateConfigs : [];
  return {
    scopeType: safeString(clause.scopeType),
    scopeLabel: RULE_SCOPE_LABEL_MAP[safeString(clause.scopeType)] || safeString(clause.scopeType),
    targetIdentity: safeString(clause.targetIdentity),
    requireAllComplete: clause.requireAllComplete === true,
    templateConfigs: templateConfigs
      .map((item) => ({
        templateId: safeString(item.templateId),
        templateName: safeString(item.templateName),
        weight: Number(item.weight),
        sortOrder: Number(item.sortOrder)
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder)
  };
}

function buildClauseText(clause) {
  const scopeText = clause.scopeLabel || '未设置被评分范围';
  const identityText = clause.targetIdentity ? `，被评分人身份：${clause.targetIdentity}` : '';
  const completeText = clause.requireAllComplete ? '，要求全评后计入核算' : '，不要求全评';
  const questionText = clause.templateConfigs.length
    ? clause.templateConfigs
      .map((config) => `${config.templateName || '未命名评分问题'}（权重：${config.weight}，顺序：${config.sortOrder}）`)
      .join('、')
    : '未配置评分问题';
  return `${scopeText}${identityText}${completeText} [${questionText}]`;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const activityId = safeString(event.activityId);

  const operator = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return {
      status: 'forbidden',
      message: '没有管理权限'
    };
  }

  const where = activityId ? { activityId } : {};
  const res = await db.collection('rate_target_rules').where(where).limit(1000).get();

  const rules = (res.data || []).map((item) => {
    const clauses = (item.clauses || []).map((clause) => normalizeClause(clause));
    return {
      id: item._id,
      activityId: safeString(item.activityId),
      activityName: safeString(item.activityName),
      scorerDepartment: safeString(item.scorerDepartment),
      scorerIdentity: safeString(item.scorerIdentity),
      clauses,
      clausesText: clauses.length
        ? clauses.map((clause) => buildClauseText(clause)).join(' | ')
        : '未配置被评分人规则'
    };
  }).sort((a, b) => {
    if (a.scorerDepartment !== b.scorerDepartment) {
      return a.scorerDepartment.localeCompare(b.scorerDepartment, 'zh-CN');
    }
    return a.scorerIdentity.localeCompare(b.scorerIdentity, 'zh-CN');
  });

  return {
    status: 'success',
    rules
  };
};
