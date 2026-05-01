const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function getOrgName(collectionName, id) {
  const safeId = safeString(id);
  if (!safeId) return '';
  const res = await db.collection(collectionName).doc(safeId).get().catch(() => ({ data: null }));
  return safeString(res.data && res.data.name);
}

async function normalizeUserFromHr(hr = {}) {
  const departmentId = safeString(hr.departmentId);
  const identityId = safeString(hr.identityId);
  const workGroupId = safeString(hr.workGroupId);

  const [department, identity, workGroup] = await Promise.all([
    getOrgName('departments', departmentId),
    getOrgName('identities', identityId),
    getOrgName('work_groups', workGroupId)
  ]);

  return {
    id: safeString(hr._id),
    hrId: safeString(hr._id),
    name: safeString(hr.name),
    studentId: safeString(hr.studentId),
    departmentId,
    department,
    identityId,
    identity,
    workGroupId,
    workGroup
  };
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const name = safeString(event.name);
  const studentId = safeString(event.studentId);

  if (!name || !studentId) {
    return { status: 'invalid_params', message: '请填写姓名和学号' };
  }

  const hrRes = await db.collection('hr_info')
    .where({ studentId })
    .limit(10)
    .get()
    .catch(() => ({ data: [] }));

  const match = (hrRes.data || []).find((item) => (
    safeString(item.name) === name
  ));

  if (!match) {
    return { status: 'bind_failed', message: '姓名或学号不匹配' };
  }

  // 检查该人事信息是否已被其他微信绑定
  const conflictRes = await db.collection('user_info')
    .where({ hrId: match._id, openid: _.neq(openid) })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));

  if (conflictRes.data.length) {
    return { status: 'bind_failed', message: '该人事信息已被其他微信绑定' };
  }

  const payload = {
    openid,
    hrId: match._id,
    updatedAt: db.serverDate(),

    // 清理旧冗余字段
    name: _.remove(),
    studentId: _.remove(),
    departmentId: _.remove(),
    departmentName: _.remove(),
    department: _.remove(),
    identityId: _.remove(),
    identityName: _.remove(),
    identity: _.remove(),
    workGroupId: _.remove(),
    workGroupName: _.remove(),
    workGroup: _.remove()
  };

  const existing = await db.collection('user_info')
    .where({ openid })
    .limit(1)
    .get();

  if (existing.data.length) {
    await db.collection('user_info').doc(existing.data[0]._id).update({
      data: payload
    });
  } else {
    await db.collection('user_info').add({
      data: {
        openid,
        hrId: match._id,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }

  return {
    status: 'bind_success',
    user: await normalizeUserFromHr(match)
  };
};