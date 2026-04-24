const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function normalizeUser(record) {
  return {
    name: record.name || record['姓名'] || '',
    studentId: record.studentId || record['学号'] || '',
    department: record.department || record['所属部门'] || '',
    identity: record.identity || record['身份'] || '',
    workGroup: record.workGroup || record['工作分工（职能组）'] || ''
  };
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const userRes = await db.collection('user_info')
    .where({ openid })
    .limit(1)
    .get();

  if (userRes.data.length > 0) {
    return {
      status: 'login_success',
      user: normalizeUser(userRes.data[0])
    };
  }

  return {
    status: 'need_bind'
  };
};
