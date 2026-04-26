const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
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

async function getCollectionRows(collectionName) {
  try {
    const rows = [];
    let skip = 0;
    while (true) {
      const res = await db.collection(collectionName).skip(skip).limit(100).get();
      const batch = res.data || [];
      rows.push(...batch);
      if (batch.length < 100) break;
      skip += batch.length;
    }
    return rows;
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

async function generateUniqueOrgCode(prefix, currentCollection, currentId) {
  for (let i = 0; i < 30; i += 1) {
    const code = createCodeCandidate(prefix);
    if (await isCodeAvailable(code, currentCollection, currentId)) {
      return code;
    }
  }
  throw new Error('生成唯一编码失败，请重试');
}

async function normalizeCode(existing, name, prefix, currentCollection, currentId) {
  const oldCode = safeString(existing && (existing.code || existing['工作分工编码']));
  if (oldCode && oldCode !== name && await isCodeAvailable(oldCode, currentCollection, currentId)) {
    return oldCode;
  }
  return generateUniqueOrgCode(prefix, currentCollection, currentId);
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

async function findByIdOrCode(collectionName, ref) {
  if (!ref) return null;
  const byId = await db.collection(collectionName).doc(ref).get().catch(() => ({ data: null }));
  if (byId.data) return byId.data;
  const byCode = await db.collection(collectionName).where({ code: ref }).limit(1).get().catch(() => ({ data: [] }));
  return (byCode.data || [])[0] || null;
}

function getDepartmentCode(department) {
  return safeString(department && (department.code || department['部门编码'] || department._id));
}

function getDepartmentName(department) {
  return safeString(department && (department.name || department['部门名称']));
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const id = safeString(event.id);
    const name = safeString(event.name);
    const departmentRef = safeString(event.departmentCode || event.departmentId);
    const description = safeString(event.description);

    if (!name) {
      return { status: 'invalid_params', message: '工作分工名称不能为空' };
    }

    if (!departmentRef) {
      return { status: 'invalid_params', message: '请选择所属部门' };
    }

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return { status: 'forbidden', message: '没有管理权限' };
    }

    const department = await findByIdOrCode('departments', departmentRef);
    if (!department) {
      return { status: 'invalid_params', message: '所属部门不存在' };
    }

    const departmentId = safeString(department._id);
    const departmentCode = getDepartmentCode(department);
    const departmentName = getDepartmentName(department);
    const rows = await getCollectionRows('work_groups');
    const duplicate = rows.find((item) => {
      const sameRecord = safeString(item._id) === id || safeString(item.code) === id;
      if (sameRecord) return false;
      const itemName = safeString(item.name || item['工作分工名称']);
      const itemDepartmentId = safeString(item.departmentId || item['所属部门ID']);
      const itemDepartmentCode = safeString(item.departmentCode || item['所属部门编码']);
      const sameDepartment = itemDepartmentCode
        ? itemDepartmentCode === departmentCode
        : itemDepartmentId === departmentId;
      return sameDepartment && itemName === name;
    });
    if (duplicate) {
      return { status: 'invalid_params', message: '该部门下的工作分工名称已存在' };
    }

    const current = await findByIdOrCode('work_groups', id);
    const currentId = safeString(current && current._id) || id;
    const code = await normalizeCode(current, name, 'WG', 'work_groups', currentId);
    const now = new Date();
    const workGroupData = {
      工作分工名称: name,
      工作分工编码: code,
      所属部门ID: departmentId,
      所属部门编码: departmentCode,
      所属部门名称: departmentName,
      排序顺序: 0,
      工作分工描述: description,
      name,
      code,
      departmentId,
      departmentCode,
      departmentName,
      sortOrder: 0,
      description,
      updatedAt: now
    };

    if (current && current._id) {
      await db.collection('work_groups').doc(current._id).update({ data: workGroupData });
    } else {
      workGroupData._id = code;
      workGroupData.createdAt = now;
      await db.collection('work_groups').add({ data: workGroupData });
    }

    return {
      status: 'success',
      message: id ? '工作分工信息更新成功' : '工作分工新增成功',
      workGroupId: code,
      id: code,
      code,
      departmentCode
    };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '保存工作分工信息失败'
    };
  }
};
