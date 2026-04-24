const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function normalizeAdmin(record) {
  const adminLevel = record.adminLevel || 'admin';
  return {
    name: record.name || record['姓名'] || '',
    studentId: record.studentId || record['学号'] || '',
    identity: adminLevel === 'super_admin' ? '超级管理员' : '普通管理员',
    adminLevel
  };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const name = String(event.name || '').trim();
  const studentId = String(event.studentId || '').trim();
  const inviteCode = String(event.inviteCode || '').trim().toUpperCase();

  if (!name || !studentId || !inviteCode) {
    return {
      status: 'invalid_params'
    };
  }

  const adminRes = await db.collection('admin_info')
    .where({
      姓名: name,
      学号: studentId,
      inviteCode
    })
    .limit(1)
    .get();

  if (!adminRes.data.length) {
    return {
      status: 'bind_failed',
      message: '邀请码、姓名或学号不匹配'
    };
  }

  const match = adminRes.data[0];

  if (match.openid && match.openid !== openid && match.bindStatus === 'active') {
    return {
      status: 'bind_failed',
      message: '该管理员已被其他微信账号绑定'
    };
  }

  const payload = {
    openid,
    name: match['姓名'],
    studentId: match['学号'],
    adminLevel: match.adminLevel || 'admin',
    inviteCode,
    bindStatus: 'active',
    boundAt: db.serverDate()
  };

  await db.collection('admin_info')
    .doc(match._id)
    .update({
      data: payload
    });

  return {
    status: 'bind_success',
    user: normalizeAdmin(payload)
  };
};
