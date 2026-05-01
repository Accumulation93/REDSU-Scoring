const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PAGE_SIZE = 100;

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function firstValue(row, fields) {
  for (const field of fields) {
    const value = safeString(row && row[field]);
    if (value) return value;
  }
  return '';
}

function createCode(prefix) {
  return `${prefix}_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

async function getAllRecords(collectionName) {
  const list = [];
  let skip = 0;
  while (true) {
    const res = await db.collection(collectionName).skip(skip).limit(PAGE_SIZE).get().catch(() => ({ data: [] }));
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }
  return list;
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
}

async function ensureNamedOrg(collectionName, name, prefix, map, statsKey, stats) {
  const safeName = safeString(name);
  if (!safeName) return null;
  if (map.has(safeName)) return map.get(safeName);
  const code = createCode(prefix);
  const addRes = await db.collection(collectionName).add({
    data: {
      name: safeName,
      code,
      sortOrder: 0,
      description: '',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  const row = { _id: addRes._id, name: safeName, code };
  map.set(safeName, row);
  stats[statsKey] += 1;
  return row;
}

async function ensureWorkGroup(name, department, map, stats) {
  const safeName = safeString(name);
  if (!safeName || !department) return null;
  const key = `${department._id}::${safeName}`;
  if (map.has(key)) return map.get(key);
  const code = createCode('WG');
  const addRes = await db.collection('work_groups').add({
    data: {
      name: safeName,
      code,
      departmentId: department._id,
      departmentCode: safeString(department.code || department._id),
      departmentName: safeString(department.name),
      sortOrder: 0,
      description: '',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });
  const row = { _id: addRes._id, name: safeName, code, departmentId: department._id, departmentName: department.name };
  map.set(key, row);
  stats.workGroupsCreated += 1;
  return row;
}

function buildOrgMap(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const name = firstValue(row, ['name', '部门名称', '身份类别名称']);
    if (name && !map.has(name)) map.set(name, row);
  });
  return map;
}

function buildWorkGroupMap(rows, departmentsById, departmentsByName) {
  const map = new Map();
  rows.forEach((row) => {
    const name = firstValue(row, ['name', '工作分工名称']);
    const departmentId = safeString(row.departmentId || row['所属部门ID']);
    const departmentName = firstValue(row, ['departmentName', '所属部门名称']);
    const department = departmentsById.get(departmentId) || departmentsByName.get(departmentName);
    if (name && department) map.set(`${department._id}::${name}`, row);
  });
  return map;
}

async function updateDoc(collectionName, id, data) {
  await db.collection(collectionName).doc(id).update({ data }).catch(() => null);
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const admin = await ensureAdmin(wxContext.OPENID);
  if (!admin) return { status: 'forbidden', message: '没有管理权限' };

  const stats = {
    departmentsCreated: 0,
    identitiesCreated: 0,
    workGroupsCreated: 0,
    departmentsUpdated: 0,
    identitiesUpdated: 0,
    workGroupsUpdated: 0,
    hrUpdated: 0,
    usersUpdated: 0,
    rulesUpdated: 0,
    scoreRecordsUpdated: 0
  };

  const [departmentRows, identityRows, workGroupRows] = await Promise.all([
    getAllRecords('departments'),
    getAllRecords('identities'),
    getAllRecords('work_groups')
  ]);
  const departmentsByName = buildOrgMap(departmentRows);
  const identitiesByName = buildOrgMap(identityRows);
  const departmentsById = new Map(departmentRows.map((row) => [safeString(row._id), row]));
  const workGroupsByKey = buildWorkGroupMap(workGroupRows, departmentsById, departmentsByName);

  await Promise.all(departmentRows.map((row) => updateDoc('departments', row._id, {
    name: firstValue(row, ['name', '部门名称']),
    code: safeString(row.code || row['部门编码'] || row._id),
    sortOrder: Number(row.sortOrder == null ? row['排序顺序'] || 0 : row.sortOrder),
    description: firstValue(row, ['description', '部门描述']),
    '部门名称': _.remove(),
    '部门编码': _.remove(),
    '排序顺序': _.remove(),
    '部门描述': _.remove(),
    updatedAt: db.serverDate()
  }).then(() => { stats.departmentsUpdated += 1; })));

  await Promise.all(identityRows.map((row) => updateDoc('identities', row._id, {
    name: firstValue(row, ['name', '身份类别名称']),
    code: safeString(row.code || row['身份类别编码'] || row._id),
    sortOrder: Number(row.sortOrder == null ? row['排序顺序'] || 0 : row.sortOrder),
    description: firstValue(row, ['description', '身份类别描述']),
    '身份类别名称': _.remove(),
    '身份类别编码': _.remove(),
    '排序顺序': _.remove(),
    '身份类别描述': _.remove(),
    updatedAt: db.serverDate()
  }).then(() => { stats.identitiesUpdated += 1; })));

  await Promise.all(workGroupRows.map((row) => {
    const departmentId = safeString(row.departmentId || row['所属部门ID']);
    const department = departmentsById.get(departmentId) || departmentsByName.get(firstValue(row, ['departmentName', '所属部门名称']));
    return updateDoc('work_groups', row._id, {
      name: firstValue(row, ['name', '工作分工名称']),
      code: safeString(row.code || row['工作分工编码'] || row._id),
      departmentId: department ? department._id : departmentId,
      departmentCode: department ? safeString(department.code || department._id) : safeString(row.departmentCode || row['所属部门编码']),
      departmentName: department ? safeString(department.name) : firstValue(row, ['departmentName', '所属部门名称']),
      sortOrder: Number(row.sortOrder == null ? row['排序顺序'] || 0 : row.sortOrder),
      description: firstValue(row, ['description', '工作分工描述']),
      '工作分工名称': _.remove(),
      '工作分工编码': _.remove(),
      '所属部门ID': _.remove(),
      '所属部门编码': _.remove(),
      '所属部门名称': _.remove(),
      '排序顺序': _.remove(),
      '工作分工描述': _.remove(),
      updatedAt: db.serverDate()
    }).then(() => { stats.workGroupsUpdated += 1; });
  }));

  const hrRows = await getAllRecords('hr_info');
  const peopleById = new Map();
  const peopleByStudentId = new Map();
  for (const row of hrRows) {
    const name = firstValue(row, ['name', '姓名']);
    const studentId = firstValue(row, ['studentId', '学号']);
    const departmentName = firstValue(row, ['departmentName', 'department', '所属部门', '学院']);
    const identityName = firstValue(row, ['identityName', 'identity', '身份']);
    const workGroupName = firstValue(row, ['workGroupName', 'workGroup', '工作分工（职能组）', '工作分工', '职能组']);
    const department = await ensureNamedOrg('departments', departmentName, 'DEP', departmentsByName, 'departmentsCreated', stats);
    if (department) departmentsById.set(department._id, department);
    const identity = await ensureNamedOrg('identities', identityName, 'IDT', identitiesByName, 'identitiesCreated', stats);
    const workGroup = await ensureWorkGroup(workGroupName, department, workGroupsByKey, stats);
    const data = {
      name,
      studentId,
      departmentId: department ? department._id : '',
      departmentName: department ? department.name : '',
      department: department ? department.name : '',
      identityId: identity ? identity._id : '',
      identityName: identity ? identity.name : '',
      identity: identity ? identity.name : '',
      workGroupId: workGroup ? workGroup._id : '',
      workGroupName: workGroup ? workGroup.name : '',
      workGroup: workGroup ? workGroup.name : '',
      qq: firstValue(row, ['qq', 'QQ']),
      college: firstValue(row, ['college', '学院']),
      major: firstValue(row, ['major', '专业']),
      gender: firstValue(row, ['gender', '性别']),
      birthDate: firstValue(row, ['birthDate', '出生日期']),
      dormAddress: firstValue(row, ['dormAddress', '宿舍地址']),
      politicalStatus: firstValue(row, ['politicalStatus', '政治面貌']),
      ethnicity: firstValue(row, ['ethnicity', '民族']),
      email: firstValue(row, ['email', '电子邮箱']),
      nativePlace: firstValue(row, ['nativePlace', '籍贯']),
      phone: firstValue(row, ['phone', '联系电话']),
      '姓名': _.remove(),
      '学号': _.remove(),
      '所属部门': _.remove(),
      '身份': _.remove(),
      '工作分工（职能组）': _.remove(),
      'QQ': _.remove(),
      '学院': _.remove(),
      '专业': _.remove(),
      '性别': _.remove(),
      '出生日期': _.remove(),
      '宿舍地址': _.remove(),
      '政治面貌': _.remove(),
      '民族': _.remove(),
      '电子邮箱': _.remove(),
      '籍贯': _.remove(),
      '联系电话': _.remove(),
      updatedAt: db.serverDate()
    };
    await updateDoc('hr_info', row._id, data);
    const person = { id: row._id, ...data };
    peopleById.set(row._id, person);
    if (studentId) peopleByStudentId.set(studentId, person);
    stats.hrUpdated += 1;
  }

  const userRows = await getAllRecords('user_info');
  for (const row of userRows) {
    const person = peopleByStudentId.get(firstValue(row, ['studentId', '学号'])) || peopleById.get(safeString(row.hrId));
    if (!person) continue;
    await updateDoc('user_info', row._id, {
      hrId: person.id,
      name: person.name,
      studentId: person.studentId,
      departmentId: person.departmentId,
      departmentName: person.departmentName,
      department: person.departmentName,
      identityId: person.identityId,
      identityName: person.identityName,
      identity: person.identityName,
      workGroupId: person.workGroupId,
      workGroupName: person.workGroupName,
      workGroup: person.workGroupName,
      updatedAt: db.serverDate()
    });
    stats.usersUpdated += 1;
  }

  const rules = await getAllRecords('rate_target_rules');
  for (const rule of rules) {
    const department = departmentsByName.get(firstValue(rule, ['scorerDepartmentName', 'scorerDepartment']));
    const identity = identitiesByName.get(firstValue(rule, ['scorerIdentityName', 'scorerIdentity']));
    if (!department || !identity) continue;
    const clauses = (rule.clauses || []).map((clause) => {
      const targetIdentityName = firstValue(clause, ['targetIdentityName', 'targetIdentity']);
      const targetIdentity = identitiesByName.get(targetIdentityName);
      return {
        ...clause,
        targetIdentityId: targetIdentity ? targetIdentity._id : '',
        targetIdentityName: targetIdentity ? targetIdentity.name : targetIdentityName,
        targetIdentity: targetIdentity ? targetIdentity.name : targetIdentityName
      };
    });
    await updateDoc('rate_target_rules', rule._id, {
      scorerDepartmentId: department._id,
      scorerDepartmentName: department.name,
      scorerDepartment: department.name,
      scorerIdentityId: identity._id,
      scorerIdentityName: identity.name,
      scorerIdentity: identity.name,
      scorerKey: `${department._id}::${identity._id}`,
      clauses,
      updatedAt: db.serverDate()
    });
    stats.rulesUpdated += 1;
  }

  const scoreRecords = await getAllRecords('score_records');
  for (const row of scoreRecords) {
    const scorer = peopleById.get(safeString(row.scorerId)) || peopleByStudentId.get(safeString(row.scorerStudentId));
    const target = peopleById.get(safeString(row.targetId)) || peopleByStudentId.get(safeString(row.targetStudentId));
    const data = { updatedAt: db.serverDate() };
    if (scorer) {
      Object.assign(data, {
        scorerDepartmentId: scorer.departmentId,
        scorerDepartment: scorer.departmentName,
        scorerIdentityId: scorer.identityId,
        scorerIdentity: scorer.identityName,
        scorerWorkGroupId: scorer.workGroupId,
        scorerWorkGroup: scorer.workGroupName
      });
    }
    if (target) {
      Object.assign(data, {
        targetDepartmentId: target.departmentId,
        targetDepartment: target.departmentName,
        targetIdentityId: target.identityId,
        targetIdentity: target.identityName,
        targetWorkGroupId: target.workGroupId,
        targetWorkGroup: target.workGroupName
      });
    }
    await updateDoc('score_records', row._id, data);
    stats.scoreRecordsUpdated += 1;
  }

  return { status: 'success', stats };
};
