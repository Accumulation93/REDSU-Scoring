const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

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

async function buildRow(binding = {}) {
  const hrId = safeString(binding.hrId);
  const hrRes = hrId
    ? await db.collection('hr_info').doc(hrId).get().catch(() => ({ data: null }))
    : { data: null };
  const hr = hrRes.data || {};
  const departmentId = safeString(hr.departmentId);
  const identityId = safeString(hr.identityId);
  const workGroupId = safeString(hr.workGroupId);
  const [department, identity, workGroup] = await Promise.all([
    getOrgName('departments', departmentId),
    getOrgName('identities', identityId),
    getOrgName('work_groups', workGroupId)
  ]);

  return {
    id: safeString(binding._id),
    openid: safeString(binding.openid),
    hrId,
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

  const operator = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return { status: 'forbidden' };
  }

  const res = await db.collection('user_info').limit(1000).get();
  const list = await Promise.all((res.data || []).map((item) => buildRow(item)));

  return {
    status: 'success',
    list
  };
};
