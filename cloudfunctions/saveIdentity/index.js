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
  const oldCode = safeString(existing && (existing.code || existing['身份类别编码']));
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

async function findIdentity(ref) {
  if (!ref) return null;
  const byId = await db.collection('identities').doc(ref).get().catch(() => ({ data: null }));
  if (byId.data) return byId.data;
  const byCode = await db.collection('identities').where({ code: ref }).limit(1).get().catch(() => ({ data: [] }));
  return (byCode.data || [])[0] || null;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const id = safeString(event.id);
    const name = safeString(event.name);
    const description = safeString(event.description);

    if (!name) {
      return { status: 'invalid_params', message: '身份类别名称不能为空' };
    }

    const admin = await ensureAdmin(openid);
    if (!admin) {
      return { status: 'forbidden', message: '没有管理权限' };
    }

    const existingByName = await db.collection('identities').where({ name }).limit(1).get().catch(() => ({ data: [] }));
    const existingByLegacyName = existingByName.data.length
      ? { data: [] }
      : await db.collection('identities').where({ 身份类别名称: name }).limit(1).get().catch(() => ({ data: [] }));
    const duplicate = [...(existingByName.data || []), ...(existingByLegacyName.data || [])]
      .find((item) => safeString(item._id) !== id && safeString(item.code) !== id);
    if (duplicate) {
      return { status: 'invalid_params', message: '身份类别名称已存在' };
    }

    const current = await findIdentity(id);
    const currentId = safeString(current && current._id) || id;
    const code = await normalizeCode(current, name, 'IDT', 'identities', currentId);
    const now = new Date();
    const identityData = {
      身份类别名称: name,
      身份类别编码: code,
      排序顺序: 0,
      身份类别描述: description,
      name,
      code,
      sortOrder: 0,
      description,
      updatedAt: now
    };

    if (current && current._id) {
      await db.collection('identities').doc(current._id).update({ data: identityData });
    } else {
      identityData._id = code;
      identityData.createdAt = now;
      await db.collection('identities').add({ data: identityData });
    }

    return {
      status: 'success',
      message: id ? '身份类别信息更新成功' : '身份类别新增成功',
      identityId: code,
      id: code,
      code
    };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '保存身份类别信息失败'
    };
  }
};
