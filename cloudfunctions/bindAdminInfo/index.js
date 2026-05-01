const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function safeString(value) { return String(value == null ? '' : value).trim(); }

function normalizeAdmin(record = {}) {
  const adminLevel = record.adminLevel || 'admin';
  return {
    name: safeString(record.name),
    studentId: safeString(record.studentId),
    identity: adminLevel === 'root_admin' ? '至高权限管理员' : (adminLevel === 'super_admin' ? '超级管理员' : '管理员'),
    adminLevel
  };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const name = safeString(event.name);
  const studentId = safeString(event.studentId);
  const inviteCode = safeString(event.inviteCode).toUpperCase();

  if (!name || !studentId || !inviteCode) return { status: 'invalid_params' };

  const adminRes = await db.collection('admin_info')
    .where({ name, studentId, inviteCode })
    .limit(1)
    .get();

  if (!adminRes.data.length) {
    return { status: 'bind_failed', message: '姓名、学号或邀请码不匹配' };
  }

  const match = adminRes.data[0];
  if (match.openid && match.openid !== openid && match.bindStatus === 'active') {
    return { status: 'bind_failed', message: '该管理员信息已被其他微信绑定' };
  }

  const payload = {
    openid,
    name: safeString(match.name),
    studentId: safeString(match.studentId),
    adminLevel: match.adminLevel || 'admin',
    inviteCode,
    bindStatus: 'active',
    boundAt: db.serverDate()
  };

  await db.collection('admin_info').doc(match._id).update({ data: payload });
  return { status: 'bind_success', user: normalizeAdmin(payload) };
};
