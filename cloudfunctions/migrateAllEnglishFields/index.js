const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 100;

const ZH = {
  name: '\u59d3\u540d',
  studentId: '\u5b66\u53f7',
  department: '\u6240\u5c5e\u90e8\u95e8',
  identity: '\u8eab\u4efd',
  workGroup: '\u5de5\u4f5c\u5206\u5de5\uff08\u804c\u80fd\u7ec4\uff09',
  qq: 'QQ',
  college: '\u5b66\u9662',
  major: '\u4e13\u4e1a',
  birthDate: '\u51fa\u751f\u65e5\u671f',
  remark: '\u5907\u6ce8',
  gender: '\u6027\u522b',
  dormAddress: '\u5bbf\u820d\u5730\u5740',
  politicalStatus: '\u653f\u6cbb\u9762\u8c8c',
  ethnicity: '\u6c11\u65cf',
  email: '\u7535\u5b50\u90ae\u7bb1',
  nativePlace: '\u7c4d\u8d2f',
  phone: '\u8054\u7cfb\u7535\u8bdd',
  departmentName: '\u90e8\u95e8\u540d\u79f0',
  departmentCode: '\u90e8\u95e8\u7f16\u7801',
  identityName: '\u8eab\u4efd\u7c7b\u522b\u540d\u79f0',
  identityCode: '\u8eab\u4efd\u7c7b\u522b\u7f16\u7801',
  workGroupName: '\u5de5\u4f5c\u5206\u5de5\u540d\u79f0',
  workGroupCode: '\u5de5\u4f5c\u5206\u5de5\u7f16\u7801',
  ownerDepartmentId: '\u6240\u5c5e\u90e8\u95e8ID',
  ownerDepartmentCode: '\u6240\u5c5e\u90e8\u95e8\u7f16\u7801',
  ownerDepartmentName: '\u6240\u5c5e\u90e8\u95e8\u540d\u79f0',
  sortOrder: '\u6392\u5e8f\u987a\u5e8f',
  description: '\u63cf\u8ff0',
  departmentDescription: '\u90e8\u95e8\u63cf\u8ff0',
  identityDescription: '\u8eab\u4efd\u7c7b\u522b\u63cf\u8ff0',
  workGroupDescription: '\u5de5\u4f5c\u5206\u5de5\u63cf\u8ff0'
};

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function hasOwn(row, field) {
  return Object.prototype.hasOwnProperty.call(row || {}, field);
}

function firstValue(row, fields) {
  for (const field of fields) {
    if (!hasOwn(row, field)) continue;
    const value = safeString(row[field]);
    if (value) return value;
  }
  return '';
}

function firstRawValue(row, fields) {
  for (const field of fields) {
    if (hasOwn(row, field) && row[field] != null && row[field] !== '') return row[field];
  }
  return '';
}

function setIfPresent(data, key, row, fields, fallback = '') {
  const value = firstRawValue(row, fields);
  if (value !== '') {
    data[key] = value;
    return;
  }
  if (fallback !== '') data[key] = fallback;
}

function removeFields(fields) {
  return fields.reduce((data, field) => {
    data[field] = _.remove();
    return data;
  }, {});
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
    const res = await db.collection(collectionName)
      .skip(skip)
      .limit(PAGE_SIZE)
      .get()
      .catch(() => ({ data: [] }));
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }
  return list;
}

async function updateDoc(collectionName, id, data) {
  await db.collection(collectionName).doc(id).update({ data });
}

function hasChineseFieldName(row) {
  return Object.keys(row || {}).some((key) => key !== '_id' && /[\u3400-\u9FFF]/.test(key));
}

async function migrateCollection(collectionName, buildData, stats) {
  const rows = await getAllRecords(collectionName);
  for (const row of rows) {
    await updateDoc(collectionName, row._id, buildData(row));
    stats[collectionName] = (stats[collectionName] || 0) + 1;
  }
}

function buildPeopleData(row) {
  const data = {};
  setIfPresent(data, 'name', row, ['name', ZH.name]);
  setIfPresent(data, 'studentId', row, ['studentId', 'school_number', ZH.studentId]);
  setIfPresent(data, 'school_number', row, ['school_number', 'studentId', ZH.studentId]);
  setIfPresent(data, 'departmentId', row, ['departmentId']);
  setIfPresent(data, 'department', row, ['department', 'departmentName', ZH.department]);
  setIfPresent(data, 'departmentName', row, ['departmentName', 'department', ZH.department]);
  setIfPresent(data, 'identityId', row, ['identityId']);
  setIfPresent(data, 'identity', row, ['identity', 'identityName', ZH.identity]);
  setIfPresent(data, 'identityName', row, ['identityName', 'identity', ZH.identity]);
  setIfPresent(data, 'workGroupId', row, ['workGroupId']);
  setIfPresent(data, 'workGroup', row, ['workGroup', 'workGroupName', ZH.workGroup]);
  setIfPresent(data, 'workGroupName', row, ['workGroupName', 'workGroup', ZH.workGroup]);
  setIfPresent(data, 'qq', row, ['qq', ZH.qq]);
  setIfPresent(data, 'college', row, ['college', ZH.college]);
  setIfPresent(data, 'major', row, ['major', ZH.major]);
  setIfPresent(data, 'birthDate', row, ['birthDate', ZH.birthDate]);
  setIfPresent(data, 'remark', row, ['remark', ZH.remark]);
  setIfPresent(data, 'gender', row, ['gender', ZH.gender]);
  setIfPresent(data, 'dormAddress', row, ['dormAddress', ZH.dormAddress]);
  setIfPresent(data, 'politicalStatus', row, ['politicalStatus', ZH.politicalStatus]);
  setIfPresent(data, 'ethnicity', row, ['ethnicity', ZH.ethnicity]);
  setIfPresent(data, 'email', row, ['email', ZH.email]);
  setIfPresent(data, 'nativePlace', row, ['nativePlace', ZH.nativePlace]);
  setIfPresent(data, 'phone', row, ['phone', ZH.phone]);

  return {
    ...data,
    ...removeFields([
      ZH.name,
      ZH.studentId,
      ZH.department,
      ZH.identity,
      ZH.workGroup,
      ZH.qq,
      ZH.college,
      ZH.major,
      ZH.birthDate,
      ZH.remark,
      ZH.gender,
      ZH.dormAddress,
      ZH.politicalStatus,
      ZH.ethnicity,
      ZH.email,
      ZH.nativePlace,
      ZH.phone
    ]),
    updatedAt: db.serverDate()
  };
}

function normalizeRuleClauses(clauses) {
  if (!Array.isArray(clauses)) return [];
  return clauses.map((clause) => ({
    ...clause,
    targetIdentityId: firstValue(clause, ['targetIdentityId']),
    targetIdentity: firstValue(clause, ['targetIdentity', 'targetIdentityName', ZH.identity]),
    targetIdentityName: firstValue(clause, ['targetIdentityName', 'targetIdentity', ZH.identity])
  }));
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '没有管理权限' };

  const stats = {};

  await migrateCollection('departments', (row) => ({
    name: firstValue(row, ['name', ZH.departmentName]),
    code: firstValue(row, ['code', ZH.departmentCode]) || row._id,
    sortOrder: numberValue(firstRawValue(row, ['sortOrder', ZH.sortOrder]), 0),
    description: firstValue(row, ['description', ZH.departmentDescription, ZH.description]),
    ...removeFields([ZH.departmentName, ZH.departmentCode, ZH.sortOrder, ZH.departmentDescription, ZH.description]),
    updatedAt: db.serverDate()
  }), stats);

  await migrateCollection('identities', (row) => ({
    name: firstValue(row, ['name', ZH.identityName]),
    code: firstValue(row, ['code', ZH.identityCode]) || row._id,
    sortOrder: numberValue(firstRawValue(row, ['sortOrder', ZH.sortOrder]), 0),
    description: firstValue(row, ['description', ZH.identityDescription, ZH.description]),
    ...removeFields([ZH.identityName, ZH.identityCode, ZH.sortOrder, ZH.identityDescription, ZH.description]),
    updatedAt: db.serverDate()
  }), stats);

  await migrateCollection('work_groups', (row) => ({
    name: firstValue(row, ['name', ZH.workGroupName]),
    code: firstValue(row, ['code', ZH.workGroupCode]) || row._id,
    departmentId: firstValue(row, ['departmentId', ZH.ownerDepartmentId]),
    departmentCode: firstValue(row, ['departmentCode', ZH.ownerDepartmentCode]),
    departmentName: firstValue(row, ['departmentName', ZH.ownerDepartmentName]),
    sortOrder: numberValue(firstRawValue(row, ['sortOrder', ZH.sortOrder]), 0),
    description: firstValue(row, ['description', ZH.workGroupDescription, ZH.description]),
    ...removeFields([
      ZH.workGroupName,
      ZH.workGroupCode,
      ZH.ownerDepartmentId,
      ZH.ownerDepartmentCode,
      ZH.ownerDepartmentName,
      ZH.sortOrder,
      ZH.workGroupDescription,
      ZH.description
    ]),
    updatedAt: db.serverDate()
  }), stats);

  await migrateCollection('hr_info', buildPeopleData, stats);
  await migrateCollection('user_info', buildPeopleData, stats);

  await migrateCollection('admin_info', (row) => ({
    name: firstValue(row, ['name', ZH.name]),
    studentId: firstValue(row, ['studentId', 'school_number', ZH.studentId]),
    school_number: firstValue(row, ['school_number', 'studentId', ZH.studentId]),
    identity: firstValue(row, ['identity', ZH.identity]),
    ...removeFields([ZH.name, ZH.studentId, ZH.identity]),
    updatedAt: db.serverDate()
  }), stats);

  await migrateCollection('rate_target_rules', (row) => ({
    scorerDepartmentId: firstValue(row, ['scorerDepartmentId']),
    scorerDepartment: firstValue(row, ['scorerDepartment', 'scorerDepartmentName']),
    scorerDepartmentName: firstValue(row, ['scorerDepartmentName', 'scorerDepartment']),
    scorerIdentityId: firstValue(row, ['scorerIdentityId']),
    scorerIdentity: firstValue(row, ['scorerIdentity', 'scorerIdentityName']),
    scorerIdentityName: firstValue(row, ['scorerIdentityName', 'scorerIdentity']),
    clauses: normalizeRuleClauses(row.clauses),
    updatedAt: db.serverDate()
  }), stats);

  await migrateCollection('score_records', (row) => ({
    scorerDepartmentId: firstValue(row, ['scorerDepartmentId']),
    scorerDepartment: firstValue(row, ['scorerDepartment']),
    scorerIdentityId: firstValue(row, ['scorerIdentityId']),
    scorerIdentity: firstValue(row, ['scorerIdentity']),
    scorerWorkGroupId: firstValue(row, ['scorerWorkGroupId']),
    scorerWorkGroup: firstValue(row, ['scorerWorkGroup']),
    targetDepartmentId: firstValue(row, ['targetDepartmentId']),
    targetDepartment: firstValue(row, ['targetDepartment']),
    targetIdentityId: firstValue(row, ['targetIdentityId']),
    targetIdentity: firstValue(row, ['targetIdentity']),
    targetWorkGroupId: firstValue(row, ['targetWorkGroupId']),
    targetWorkGroup: firstValue(row, ['targetWorkGroup']),
    updatedAt: db.serverDate()
  }), stats);

  await migrateCollection('hr_profile_records', buildPeopleData, stats);

  const chineseFieldLeft = {};
  for (const collectionName of [
    'departments',
    'identities',
    'work_groups',
    'hr_info',
    'user_info',
    'admin_info',
    'rate_target_rules',
    'score_records',
    'hr_profile_records'
  ]) {
    const rows = await getAllRecords(collectionName);
    const count = rows.filter((row) => hasChineseFieldName(row)).length;
    if (count) chineseFieldLeft[collectionName] = count;
  }

  return {
    status: 'success',
    message: '中文字段已迁移为英文字段并删除',
    stats,
    chineseFieldLeft
  };
};
