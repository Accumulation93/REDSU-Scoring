const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function ensureAdmin(openid) {
  const operator = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return operator.data[0] || null;
}

async function getById(collectionName, id) {
  const safeId = safeString(id);
  if (!safeId) return null;
  const res = await db.collection(collectionName).doc(safeId).get().catch(() => ({ data: null }));
  return res.data || null;
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = safeString(event.id);
  const name = safeString(event.name);
  const studentId = safeString(event.studentId);
  const departmentId = safeString(event.departmentId);
  const identityId = safeString(event.identityId);
  const workGroupId = safeString(event.workGroupId);

  const operator = await ensureAdmin(openid);
  if (!operator) {
    return { status: 'forbidden', message: '没有管理权限' };
  }

  if (!name || !studentId || !departmentId || !identityId) {
    return { status: 'invalid_params', message: '姓名、学号、部门ID和身份ID为必填项' };
  }

  const [department, identity, workGroup] = await Promise.all([
    getById('departments', departmentId),
    getById('identities', identityId),
    workGroupId ? getById('work_groups', workGroupId) : Promise.resolve(null)
  ]);

  if (!department) {
    return { status: 'invalid_params', message: '部门不存在，请先在部门维护中添加' };
  }

  if (!identity) {
    return { status: 'invalid_params', message: '身份类别不存在，请先在身份类别维护中添加' };
  }

  if (workGroupId && (!workGroup || safeString(workGroup.departmentId) !== departmentId)) {
    return { status: 'invalid_params', message: '工作分工不存在，或不属于当前部门' };
  }

  const payload = {
    name,
    studentId,
    departmentId,
    identityId,
    workGroupId,
    departmentName: _.remove(),
    identityName: _.remove(),
    workGroupName: _.remove(),
    department: _.remove(),
    identity: _.remove(),
    workGroup: _.remove(),
    school_number: _.remove(),
    updatedAt: db.serverDate()
  };

  if (id) {
    await db.collection('hr_info').doc(id).update({ data: payload });
  } else {
    const existingByStudentId = await db.collection('hr_info').where({ studentId }).limit(1).get();
    if (existingByStudentId.data.length) {
      await db.collection('hr_info').doc(existingByStudentId.data[0]._id).update({ data: payload });
    } else {
      await db.collection('hr_info').add({
        data: {
          ...payload,
          createdAt: db.serverDate()
        }
      });
    }
  }

  return { status: 'success' };
};
