const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

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

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const userRes = await db.collection('user_info')
    .where({ openid })
    .limit(1)
    .get();

  if (!userRes.data.length) {
    return { status: 'need_bind' };
  }

  const binding = userRes.data[0];
  const hrId = safeString(binding.hrId);

  if (!hrId) {
    return { status: 'need_bind' };
  }

  const hrRes = await db.collection('hr_info').doc(hrId).get().catch(() => ({ data: null }));

  if (!hrRes.data) {
    return { status: 'need_bind', message: '绑定的人事信息不存在，请重新绑定' };
  }

  return {
    status: 'login_success',
    user: await normalizeUserFromHr(hrRes.data)
  };
};