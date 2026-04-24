const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event) => {
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
    return {
      status: 'forbidden',
      message: '没有管理权限'
    };
  }

  if (!id) {
    return {
      status: 'invalid_params',
      message: '请提供活动记录'
    };
  }

  await db.collection('score_activities')
    .where({
      isCurrent: true
    })
    .update({
      data: {
        isCurrent: false,
        updatedAt: db.serverDate(),
        updatedBy: operator.data[0]._id
      }
    });

  await db.collection('score_activities')
    .doc(id)
    .update({
      data: {
        isCurrent: true,
        updatedAt: db.serverDate(),
        updatedBy: operator.data[0]._id
      }
    });

  return {
    status: 'success'
  };
};
