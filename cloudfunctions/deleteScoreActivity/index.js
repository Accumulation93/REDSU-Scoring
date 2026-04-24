const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

async function removeByQuery(collectionName, where) {
  while (true) {
    const res = await db.collection(collectionName)
      .where(where)
      .limit(100)
      .get();

    if (!res.data.length) {
      return;
    }

    for (const item of res.data) {
      await db.collection(collectionName).doc(item._id).remove();
    }
  }
}

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

  await removeByQuery('rate_target_rules', { activityId: id });
  await removeByQuery('score_records', { activityId: id });

  await db.collection('score_activities')
    .doc(id)
    .remove();

  return {
    status: 'success'
  };
};
