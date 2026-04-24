const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const orderedIds = Array.isArray(event.orderedIds) ? event.orderedIds.map((item) => String(item || '').trim()).filter(Boolean) : [];

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

  if (!orderedIds.length) {
    return {
      status: 'invalid_params',
      message: '缺少模板排序信息'
    };
  }

  await Promise.all(orderedIds.map((id, index) => db.collection('score_question_templates')
    .doc(id)
    .update({
      data: {
        sortOrder: index + 1,
        updatedAt: db.serverDate(),
        updatedBy: operator.data[0]._id
      }
    })));

  return {
    status: 'success'
  };
};
