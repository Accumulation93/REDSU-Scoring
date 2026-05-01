const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();

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

  if (!id) {
    return { status: 'invalid_params' };
  }

  await db.collection('hr_info').doc(id).remove();

  const userRes = await db.collection('user_info')
    .where({ hrId: id })
    .get();

  for (const item of userRes.data) {
    await db.collection('user_info').doc(item._id).remove();
  }

  return { status: 'success' };
};
