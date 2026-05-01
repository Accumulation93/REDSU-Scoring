const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PAGE_SIZE = 100;

function safeString(value) {
  return String(value == null ? '' : value).trim();
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

function buildOrgMap(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const id = safeString(row && row._id);
    if (!id) return;
    map.set(id, safeString(row.name));
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
    departmentsById: buildOrgMap(departments),
    identitiesById: buildOrgMap(identities),
    workGroupsById: buildOrgMap(workGroups)
  };
}

function lookupName(map, id) {
  return (map && map.get(safeString(id))) || '';
}

async function ensureAdmin(openid) {
  const operator = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return operator.data[0] || null;
}

function firstValue(row, fields) {
  for (const field of fields) {
    const value = safeString(row && row[field]);
    if (value) return value;
  }
  return '';
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const operator = await ensureAdmin(openid);
  if (!operator) {
    return { status: 'forbidden', message: '没有管理权限' };
  }

  const [rows, orgLookups] = await Promise.all([
    getAllRecords(db.collection('hr_info')),
    fetchOrgLookups()
  ]);
  const list = rows.map((item) => {
    const departmentId = safeString(item.departmentId);
    const identityId = safeString(item.identityId);
    const workGroupId = safeString(item.workGroupId);
    return {
      id: item._id,
      name: safeString(item.name),
      studentId: safeString(item.studentId),
      departmentId,
      department: lookupName(orgLookups.departmentsById, departmentId),
      identityId,
      identity: lookupName(orgLookups.identitiesById, identityId),
      workGroupId,
      workGroup: lookupName(orgLookups.workGroupsById, workGroupId)
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return { status: 'success', list };
};
