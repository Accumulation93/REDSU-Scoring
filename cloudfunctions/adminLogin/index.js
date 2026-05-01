const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function normalizeAdmin(record) {
  const adminLevel = record.adminLevel || 'admin';
  let identity = '管理员';
  if (adminLevel === 'root_admin') identity = '至高权限管理员';
  else if (adminLevel === 'super_admin') identity = '超级管理员';
  return {
    name: record.name || '',
    studentId: record.studentId || '',
    identity,
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
