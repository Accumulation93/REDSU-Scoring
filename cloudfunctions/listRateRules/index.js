const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PAGE_SIZE = 100;

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

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
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
    const id = safeString(item._id);
    if (id) map.set(id, safeString(item.name));
  });
  return map;
}

async function fetchOrgLookups() {
  const [departments, identities, templates, activities] = await Promise.all([
    getAllRecords(db.collection('departments')),
    getAllRecords(db.collection('identities')),
    getAllRecords(db.collection('score_question_templates')),
    getAllRecords(db.collection('score_activities'))
  ]);
  return {
    departmentsById: buildNameMap(departments),
    identitiesById: buildNameMap(identities),
    templatesById: buildNameMap(templates),
    activitiesById: buildNameMap(activities)
  };
}

function normalizeClause(clause = {}, lookups = {}) {
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
      sortOrder: Number(item.sortOrder)
    })).sort((a, b) => a.sortOrder - b.sortOrder)
  };
}

function buildClauseText(clause) {
  const identityText = clause.targetIdentity ? '，被评分人身份：' + clause.targetIdentity : '';
  const completeText = clause.requireAllComplete ? '，要求全评后计入核算' : '，不要求全评';
  const questionText = clause.templateConfigs.length
    ? clause.templateConfigs.map((config) => (config.templateName || '未命名评分问题') + '（权重：' + config.weight + '，顺序：' + config.sortOrder + '）').join('、')
    : '未配置评分问题';
  return (clause.scopeLabel || '未设置被评分范围') + identityText + completeText + ' [' + questionText + ']';
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '无管理权限' };

  const activityId = safeString(event.activityId);
  const where = activityId ? { activityId } : {};
  const [res, lookups] = await Promise.all([
    db.collection('rate_target_rules').where(where).limit(1000).get(),
    fetchOrgLookups()
  ]);
  const rules = (res.data || []).map((item) => {
    const scorerDepartmentId = safeString(item.scorerDepartmentId);
    const scorerIdentityId = safeString(item.scorerIdentityId);
    const clauses = (item.clauses || []).map((clause) => normalizeClause(clause, lookups));
    return {
      id: item._id,
      activityId: safeString(item.activityId),
      activityName: safeString(lookups.activitiesById.get(safeString(item.activityId))),
      scorerDepartmentId,
      scorerDepartment: safeString(lookups.departmentsById.get(scorerDepartmentId)),
      scorerIdentityId,
      scorerIdentity: safeString(lookups.identitiesById.get(scorerIdentityId)),
      clauses,
      clausesText: clauses.length ? clauses.map((clause) => buildClauseText(clause)).join(' | ') : '未配置被评分人规则'
    };
  }).sort((a, b) => {
    if (a.scorerDepartment !== b.scorerDepartment) return a.scorerDepartment.localeCompare(b.scorerDepartment, 'zh-CN');
    return a.scorerIdentity.localeCompare(b.scorerIdentity, 'zh-CN');
  });

  return { status: 'success', rules };
};
