const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const name = String(event.name || '').trim();
  const studentId = String(event.studentId || '').trim();

  if (!name || !studentId) {
    return {
      status: 'invalid_params',
      message: '请提供姓名和学号'
    };
  }

  const hrRes = await db.collection('hr_info')
    .where({ studentId })
    .limit(1)
    .get();

  if (!hrRes.data.length || String(hrRes.data[0].name || '') !== name) {
    return {
      status: 'invalid_params',
      message: '请从 hr_info 中选择有效成员初始化超级管理员'
    };
  }

  const existingSuperAdmin = await db.collection('admin_info')
    .where({
      adminLevel: 'super_admin',
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (existingSuperAdmin.data.length) {
    return {
      status: 'forbidden',
      message: '系统中已存在超级管理员'
    };
  }

  const existing = await db.collection('admin_info')
    .where({ studentId })
    .limit(1)
    .get();

  const payload = {
    name,
    studentId,
    openid,
    adminLevel: 'super_admin',
    bindStatus: 'active',
    inviteCode: 'BOOTSTRAP',
    invitedAt: db.serverDate(),
    boundAt: db.serverDate()
  };

  if (existing.data.length) {
    await db.collection('admin_info').doc(existing.data[0]._id).update({ data: payload });
  } else {
    await db.collection('admin_info').add({ data: payload });
  }

  return {
    status: 'success',
    message: '超级管理员初始化成功'
  };
};
