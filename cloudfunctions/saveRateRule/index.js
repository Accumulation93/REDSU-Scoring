const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const VALID_SCOPES = ['same_department_identity', 'same_department_all', 'same_work_group_identity', 'same_work_group_all', 'identity_only', 'all_people'];
const IDENTITY_REQUIRED_SCOPES = ['same_department_identity', 'same_work_group_identity', 'identity_only'];

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
}

async function getOrgById(collectionName, id) {
  const safeId = safeString(id);
  if (!safeId) return null;
  const res = await db.collection(collectionName).doc(safeId).get().catch(() => ({ data: null }));
  return res.data || null;
}

function toBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeTemplateConfigs(clause = {}) {
  if (Array.isArray(clause.templateConfigs)) return clause.templateConfigs;
  if (clause.templateId) {
    return [{ templateId: clause.templateId, weight: clause.weight == null ? 1 : clause.weight, sortOrder: clause.sortOrder == null ? 1 : clause.sortOrder }];
  }
  return [];
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '无管理权限' };

  const id = safeString(event.id);
  const activityId = safeString(event.activityId);
  const scorerDepartmentId = safeString(event.scorerDepartmentId);
  const scorerIdentityId = safeString(event.scorerIdentityId);
  const clauses = Array.isArray(event.clauses) ? event.clauses : [];
  const mode = safeString(event.mode) === 'replace' ? 'replace' : 'strict';

  if (!activityId || !scorerDepartmentId || !scorerIdentityId) {
    return { status: 'invalid_params', message: '请提供评分活动ID和评分人部门、身份ID' };
  }

  const [activityRes, scorerDepartment, scorerIdentity] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    getOrgById('departments', scorerDepartmentId),
    getOrgById('identities', scorerIdentityId)
  ]);
  if (!activityRes.data) return { status: 'invalid_params', message: '评分活动不存在' };
  if (!scorerDepartment || !scorerIdentity) return { status: 'invalid_params', message: '评分人部门或身份不存在' };

  const normalizedClauses = [];
  for (const clause of clauses) {
    const scopeType = safeString(clause.scopeType);
    if (!VALID_SCOPES.includes(scopeType)) {
      return { status: 'invalid_params', message: '无效的被评分范围' };
    }

    const targetIdentityId = IDENTITY_REQUIRED_SCOPES.includes(scopeType) ? safeString(clause.targetIdentityId) : '';
    let targetIdentity = null;
    if (targetIdentityId) {
      targetIdentity = await getOrgById('identities', targetIdentityId);
      if (!targetIdentity) return { status: 'invalid_params', message: '被评分人身份不存在' };
    } else if (IDENTITY_REQUIRED_SCOPES.includes(scopeType)) {
      return { status: 'invalid_params', message: '请提供被评分人身份ID' };
    }

    const templateConfigs = [];
    for (const item of normalizeTemplateConfigs(clause)) {
      const templateId = safeString(item.templateId);
      if (!templateId) continue;
      const templateRes = await db.collection('score_question_templates').doc(templateId).get().catch(() => ({ data: null }));
      if (!templateRes.data) return { status: 'invalid_params', message: '评分问题模板不存在' };
      const weight = Number(item.weight);
      const sortOrder = Number(item.sortOrder);
      if (!Number.isFinite(weight) || weight <= 0 || !Number.isInteger(sortOrder) || sortOrder <= 0) {
        return { status: 'invalid_params', message: '权重和顺序必须为正整数' };
      }
      templateConfigs.push({ templateId, weight, sortOrder });
    }

    normalizedClauses.push({
      scopeType,
      targetIdentityId,
      requireAllComplete: toBoolean(clause.requireAllComplete),
      templateConfigs: templateConfigs.sort((a, b) => a.sortOrder - b.sortOrder)
    });
  }

  // 被评分人规则去重：按 scopeType + targetIdentityId 组成唯一键
  const dedupedClauses = [];
  const seenKeys = new Map();
  for (const clause of normalizedClauses) {
    const clauseKey = clause.scopeType + '::' + clause.targetIdentityId;
    const existingIndex = seenKeys.get(clauseKey);
    if (existingIndex !== undefined) {
      if (mode === 'replace') {
        dedupedClauses[existingIndex] = clause;
      } else {
        return { status: 'duplicate_clause', message: '被评分人规则重复：同一评分人类别中，被评分范围+被评分人身份不能重复，请检查后重新提交' };
      }
    } else {
      seenKeys.set(clauseKey, dedupedClauses.length);
      dedupedClauses.push(clause);
    }
  }

  const scorerKey = scorerDepartmentId + '::' + scorerIdentityId;
  const payload = {
    activityId,
    scorerKey,
    scorerDepartmentId,
    scorerIdentityId,
    clauses: dedupedClauses,
    isActive: true,
    updatedAt: db.serverDate()
  };

  let ruleId = id;
  if (id) {
    await db.collection('rate_target_rules').doc(id).update({ data: { ...payload, activityName: _.remove() } });
  } else {
    const existing = await db.collection('rate_target_rules').where({ activityId, scorerKey }).limit(1).get();
    if (existing.data.length) {
      if (mode === 'replace') {
        ruleId = existing.data[0]._id;
        await db.collection('rate_target_rules').doc(ruleId).update({ data: { ...payload, activityName: _.remove() } });
      } else {
        return { status: 'duplicate_category', message: '该评分人类别已存在（相同评分人部门+身份），请勿重复保存' };
      }
    } else {
      const addRes = await db.collection('rate_target_rules').add({ data: { ...payload, createdAt: db.serverDate() } });
      ruleId = addRes._id;
    }
  }
  return {
    status: 'success',
    id: ruleId,
    rule: {
      id: ruleId,
      activityId,
      scorerDepartmentId,
      scorerDepartment: safeString(scorerDepartment.name),
      scorerIdentityId,
      scorerIdentity: safeString(scorerIdentity.name),
      clauses: dedupedClauses.map((clause) => ({
        ...clause,
        targetIdentity: ''
      }))
    }
  };
};
