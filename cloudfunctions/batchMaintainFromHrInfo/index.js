const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PAGE_SIZE = 100;
const ORG_COLLECTIONS = [
  { name: 'departments', legacyCodeFields: ['部门编码'] },
  { name: 'work_groups', legacyCodeFields: ['工作分工编码'] },
  { name: 'identities', legacyCodeFields: ['身份类别编码'] }
];

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function createCodeCandidate(prefix) {
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${prefix}_${timePart}_${randomPart}`;
}

async function getAllRecords(query) {
  const list = [];
  let skip = 0;

  while (true) {
    const res = await query.skip(skip).limit(PAGE_SIZE).get();
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }

  return list;
}

async function getCollectionRows(collectionName) {
  try {
    return await getAllRecords(db.collection(collectionName));
  } catch (e) {
    return [];
  }
}

async function isCodeAvailable(code, currentCollection, currentId) {
  for (const collection of ORG_COLLECTIONS) {
    const rows = await getCollectionRows(collection.name);
    const duplicated = rows.some((item) => {
      const sameRecord = collection.name === currentCollection
        && (safeString(item._id) === currentId || safeString(item.code) === currentId);
      if (sameRecord) return false;
      const codes = [item._id, item.code, ...collection.legacyCodeFields.map((field) => item[field])].map(safeString);
      return codes.includes(code);
    });
    if (duplicated) return false;
  }
  return true;
}

async function generateUniqueOrgCode(prefix, currentCollection, currentId = '') {
  for (let i = 0; i < 30; i += 1) {
    const code = createCodeCandidate(prefix);
    if (await isCodeAvailable(code, currentCollection, currentId)) {
      return code;
    }
  }
  throw new Error('生成唯一编码失败，请重试');
}

async function ensureValidCode(record, name, prefix, collectionName, legacyCodeField) {
  const recordId = safeString(record && record._id);
  const oldCode = safeString(record && (record.code || record[legacyCodeField]));
  if (oldCode && oldCode !== name && await isCodeAvailable(oldCode, collectionName, recordId)) {
    return { code: oldCode, changed: false };
  }
  return {
    code: await generateUniqueOrgCode(prefix, collectionName, recordId),
    changed: true
  };
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

function buildNameMap(rows, legacyNameField) {
  const map = new Map();
  rows.forEach((item) => {
    const name = safeString(item.name || item[legacyNameField]);
    if (name && !map.has(name)) {
      map.set(name, item);
    }
  });
  return map;
}

exports.main = async () => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return { status: 'forbidden', message: '没有管理权限' };
    }

    const hrData = await getCollectionRows('hr_info');
    const departmentNames = new Set();
    const identityNames = new Set();
    const workGroupKeys = new Map();

    hrData.forEach((item) => {
      const department = safeString(item.department || item['所属部门']);
      const identity = safeString(item.identity || item['身份']);
      const workGroup = safeString(item.workGroup || item['工作分工（职能组）']);

      if (department) departmentNames.add(department);
      if (identity) identityNames.add(identity);
      if (department && workGroup) {
        workGroupKeys.set(`${department}::${workGroup}`, { department, workGroup });
      }
    });

    const stats = {
      departmentsCreated: 0,
      departmentsUpdated: 0,
      identitiesCreated: 0,
      identitiesUpdated: 0,
      workGroupsCreated: 0,
      workGroupsUpdated: 0,
      skipped: 0
    };
    const now = new Date();

    let departmentRows = await getCollectionRows('departments');
    let departmentMap = buildNameMap(departmentRows, '部门名称');
    for (const name of departmentNames) {
      const existing = departmentMap.get(name);
      if (existing) {
        const { code, changed } = await ensureValidCode(existing, name, 'DEP', 'departments', '部门编码');
        if (changed) {
          await db.collection('departments').doc(existing._id).update({
            data: { code, 部门编码: code, updatedAt: now }
          });
          stats.departmentsUpdated += 1;
        } else {
          stats.skipped += 1;
        }
        existing.code = code;
        existing['部门编码'] = code;
        continue;
      }

      const code = await generateUniqueOrgCode('DEP', 'departments');
      const row = {
        _id: code,
        部门名称: name,
        部门编码: code,
        排序顺序: 0,
        部门描述: '',
        name,
        code,
        sortOrder: 0,
        description: '',
        createdAt: now,
        updatedAt: now
      };
      await db.collection('departments').add({ data: row });
      departmentMap.set(name, row);
      stats.departmentsCreated += 1;
    }

    let identityRows = await getCollectionRows('identities');
    const identityMap = buildNameMap(identityRows, '身份类别名称');
    for (const name of identityNames) {
      const existing = identityMap.get(name);
      if (existing) {
        const { code, changed } = await ensureValidCode(existing, name, 'IDT', 'identities', '身份类别编码');
        if (changed) {
          await db.collection('identities').doc(existing._id).update({
            data: { code, 身份类别编码: code, updatedAt: now }
          });
          stats.identitiesUpdated += 1;
        } else {
          stats.skipped += 1;
        }
        existing.code = code;
        existing['身份类别编码'] = code;
        continue;
      }

      const code = await generateUniqueOrgCode('IDT', 'identities');
      const row = {
        _id: code,
        身份类别名称: name,
        身份类别编码: code,
        排序顺序: 0,
        身份类别描述: '',
        name,
        code,
        sortOrder: 0,
        description: '',
        createdAt: now,
        updatedAt: now
      };
      await db.collection('identities').add({ data: row });
      identityMap.set(name, row);
      stats.identitiesCreated += 1;
    }

    departmentRows = await getCollectionRows('departments');
    departmentMap = buildNameMap(departmentRows, '部门名称');
    const workGroupRows = await getCollectionRows('work_groups');
    const workGroupMap = new Map();
    workGroupRows.forEach((item) => {
      const name = safeString(item.name || item['工作分工名称']);
      const departmentCode = safeString(item.departmentCode || item['所属部门编码']);
      const departmentId = safeString(item.departmentId || item['所属部门ID']);
      const key = `${departmentCode || departmentId}::${name}`;
      if (name && !workGroupMap.has(key)) {
        workGroupMap.set(key, item);
      }
    });

    for (const { department, workGroup } of workGroupKeys.values()) {
      const departmentRow = departmentMap.get(department);
      if (!departmentRow) {
        stats.skipped += 1;
        continue;
      }
      const departmentId = safeString(departmentRow._id);
      const departmentCode = safeString(departmentRow.code || departmentRow['部门编码'] || departmentRow._id);
      const existing = workGroupMap.get(`${departmentCode}::${workGroup}`)
        || workGroupMap.get(`${departmentId}::${workGroup}`);

      if (existing) {
        const { code, changed } = await ensureValidCode(existing, workGroup, 'WG', 'work_groups', '工作分工编码');
        const needsDepartmentCode = !safeString(existing.departmentCode || existing['所属部门编码']);
        if (changed || needsDepartmentCode) {
          await db.collection('work_groups').doc(existing._id).update({
            data: {
              code,
              工作分工编码: code,
              departmentId,
              departmentCode,
              departmentName: department,
              所属部门ID: departmentId,
              所属部门编码: departmentCode,
              所属部门名称: department,
              updatedAt: now
            }
          });
          stats.workGroupsUpdated += 1;
        } else {
          stats.skipped += 1;
        }
        continue;
      }

      const code = await generateUniqueOrgCode('WG', 'work_groups');
      await db.collection('work_groups').add({
        data: {
          _id: code,
          工作分工名称: workGroup,
          工作分工编码: code,
          所属部门ID: departmentId,
          所属部门编码: departmentCode,
          所属部门名称: department,
          排序顺序: 0,
          工作分工描述: '',
          name: workGroup,
          code,
          departmentId,
          departmentCode,
          departmentName: department,
          sortOrder: 0,
          description: '',
          createdAt: now,
          updatedAt: now
        }
      });
      stats.workGroupsCreated += 1;
    }

    return {
      status: 'success',
      message: '组织字典已从人事成员同步',
      stats
    };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '批量同步组织字典失败'
    };
  }
};
