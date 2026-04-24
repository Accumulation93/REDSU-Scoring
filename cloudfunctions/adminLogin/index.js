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

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const adminRes = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (adminRes.data.length > 0) {
    return {
      status: 'login_success',
      user: normalizeAdmin(adminRes.data[0])
    };
  }

  return {
    status: 'need_bind'
  };
};
