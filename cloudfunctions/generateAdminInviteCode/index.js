const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function createCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function generateUniqueCode() {
  for (let i = 0; i < 10; i += 1) {
    const inviteCode = createCode();
    const res = await db.collection('admin_info')
      .where({ inviteCode })
      .limit(1)
      .get();

    if (!res.data.length) {
      return inviteCode;
    }
  }

  throw new Error('failed_to_generate_invite_code');
}

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const operatorRes = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();

  if (!operatorRes.data.length) {
    return {
      status: 'forbidden',
      message: '没有管理员权限'
    };
  }

  const operatorLevel = operatorRes.data[0].adminLevel || 'admin';
  if (operatorLevel !== 'root_admin' && operatorLevel !== 'super_admin') {
    return {
      status: 'forbidden',
      message: '仅至高权限管理员或超级管理员可以生成邀请码'
    };
  }

  return {
    status: 'success',
    inviteCode: await generateUniqueCode()
  };
};
