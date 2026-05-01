const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 100;

const PURGE_FIELDS = {
  hr_info: [
    'department',
    'departmentName',
    'identity',
    'identityName',
    'workGroup',
    'workGroupName',
    '所属部门',
    '身份',
    '工作分工（职能组）'
  ],
  user_info: [
    'department',
    'departmentName',
    'identity',
    'identityName',
    'workGroup',
    'workGroupName',
    '所属部门',
    '身份',
    '工作分工（职能组）'
  ],
  rate_target_rules: [
    'activityName',
    'scorerDepartment',
    'scorerDepartmentName',
    'scorerIdentity',
    'scorerIdentityName'
  ],
  score_records: [
    'activityName',
    'templateDisplayName',
    'templateScores',
    'scorerOpenId',
    'scorerName',
    'scorerStudentId',
    'scorerDepartmentId',
    'scorerDepartment',
    'scorerIdentityId',
    'scorerIdentity',
    'scorerWorkGroupId',
    'scorerWorkGroup',
    'targetName',
    'targetStudentId',
    'targetDepartmentId',
    'targetDepartment',
    'targetIdentityId',
    'targetIdentity',
    'targetWorkGroupId',
    'targetWorkGroup'
  ],
  departments: [
    'code',
    'sortOrder'
  ],
  identities: [
    'code',
    'sortOrder'
  ],
  score_question_templates: [
    'sortOrder'
  ],
  work_groups: [
    'code',
    'departmentCode',
    'departmentName',
    'sortOrder',
    'sort_order'
  ],
  hr_profile_records: [
    'name',
    'studentId',
    'department',
    'departmentName',
    'identity',
    'identityName',
    'workGroup',
    'workGroupName',
    '姓名',
    '所属部门',
    '身份',
    '工作分工（职能组）'
  ],
  admin_info: [
    'school_number',
    '姓名',
    '学号',
    '身份'
  ]
};

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

async function getAllRecords(collectionName) {
  const list = [];
  let skip = 0;
  while (true) {
    const res = await db.collection(collectionName).where({}).skip(skip).limit(PAGE_SIZE).get().catch(() => ({ data: [] }));
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }
  return list;
}

function buildRemoveData(fields) {
  return fields.reduce((data, field) => {
    data[field] = _.remove();
    return data;
  }, {});
}

function hasAnyField(row, fields) {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(row, field));
}

function cleanRuleClauses(clauses) {
  let changed = false;
  const nextClauses = (Array.isArray(clauses) ? clauses : []).map((clause) => {
    const next = { ...clause };
    if (Object.prototype.hasOwnProperty.call(next, 'targetIdentity')) {
      delete next.targetIdentity;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(next, 'targetIdentityName')) {
      delete next.targetIdentityName;
      changed = true;
    }
    return next;
  });
  return { changed, clauses: nextClauses };
}

async function purgeCollection(collectionName, fields, stats) {
  const rows = await getAllRecords(collectionName);
  const removeData = buildRemoveData(fields);
  for (const row of rows) {
    const shouldRemoveFields = hasAnyField(row, fields);
    const extraData = {};
    let shouldUpdate = shouldRemoveFields;

    if (collectionName === 'rate_target_rules') {
      const result = cleanRuleClauses(row.clauses);
      if (result.changed) {
        extraData.clauses = result.clauses;
        shouldUpdate = true;
      }
    }

    if (!shouldUpdate) continue;
    await db.collection(collectionName).doc(row._id).update({
      data: {
        ...removeData,
        ...extraData,
        updatedAt: db.serverDate()
      }
    });
    stats[collectionName] = (stats[collectionName] || 0) + 1;
  }
}

async function scanLeftovers() {
  const leftovers = {};
  for (const [collectionName, fields] of Object.entries(PURGE_FIELDS)) {
    const rows = await getAllRecords(collectionName);
    const count = rows.filter((row) => {
      if (hasAnyField(row, fields)) return true;
      if (collectionName === 'rate_target_rules') {
        return (row.clauses || []).some((clause) => (
          Object.prototype.hasOwnProperty.call(clause, 'targetIdentity')
          || Object.prototype.hasOwnProperty.call(clause, 'targetIdentityName')
        ));
      }
      return false;
    }).length;
    if (count) leftovers[collectionName] = count;
  }
  return leftovers;
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '没有管理权限' };

  const stats = {};
  for (const [collectionName, fields] of Object.entries(PURGE_FIELDS)) {
    await purgeCollection(collectionName, fields, stats);
  }

  const leftovers = await scanLeftovers();
  return {
    status: Object.keys(leftovers).length ? 'error' : 'success',
    message: Object.keys(leftovers).length ? '仍有名称冗余字段残留' : '名称冗余字段已清理干净',
    stats,
    leftovers
  };
};
