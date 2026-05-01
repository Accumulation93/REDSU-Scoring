const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const PAGE_SIZE = 100;

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
    const res = await query.where({}).skip(skip).limit(PAGE_SIZE).get();
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
  const [departments, identities] = await Promise.all([
    getAllRecords(db.collection('departments')),
    getAllRecords(db.collection('identities'))
  ]);
  return {
    departmentsById: buildNameMap(departments),
    identitiesById: buildNameMap(identities)
  };
}

async function runInBatches(items, handler, batchSize = 20) {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map((item) => handler(item)));
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '无管理权限' };

  const activityId = safeString(event.activityId);
  if (!activityId) return { status: 'invalid_params', message: '请提供评分活动ID' };
  const activityRes = await db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null }));
  if (!activityRes.data) return { status: 'invalid_params', message: '评分活动不存在' };

  const [hrRows, existingRules, lookups] = await Promise.all([
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId })),
    fetchOrgLookups()
  ]);

  const categories = new Map();
  hrRows.forEach((item) => {
    const departmentId = safeString(item.departmentId);
    const identityId = safeString(item.identityId);
    if (!departmentId || !identityId) return;
    const scorerKey = departmentId + '::' + identityId;
    if (!categories.has(scorerKey)) {
      categories.set(scorerKey, {
        activityId,
        scorerKey,
        scorerDepartmentId: departmentId,
        scorerIdentityId: identityId,
        clauses: [],
        isActive: true
      });
    }
  });

  const existingRuleMap = new Map();
  const duplicateRuleIds = [];
  existingRules.forEach((item) => {
    const key = safeString(item.scorerKey);
    if (!key) {
      duplicateRuleIds.push(item._id);
      return;
    }
    if (!existingRuleMap.has(key)) existingRuleMap.set(key, item);
    else duplicateRuleIds.push(item._id);
  });

  const rulesToAdd = [];
  for (const rule of categories.values()) {
    if (!existingRuleMap.has(rule.scorerKey)) rulesToAdd.push(rule);
  }

  await runInBatches(duplicateRuleIds, (id) => db.collection('rate_target_rules').doc(id).remove());
  await runInBatches(rulesToAdd, (rule) => db.collection('rate_target_rules').add({
    data: { ...rule, createdAt: db.serverDate(), updatedAt: db.serverDate() }
  }));
  return {
    status: 'success',
    collectionName: 'rate_target_rules',
    ruleCount: categories.size,
    createdCount: rulesToAdd.length,
    keptCount: categories.size - rulesToAdd.length,
    removedDuplicateCount: duplicateRuleIds.length,
    departmentsResolved: Array.from(categories.values()).filter((rule) => lookups.departmentsById.has(rule.scorerDepartmentId)).length,
    identitiesResolved: Array.from(categories.values()).filter((rule) => lookups.identitiesById.has(rule.scorerIdentityId)).length
  };
};
