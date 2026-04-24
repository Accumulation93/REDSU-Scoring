const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();
  const name = String(event.name || '').trim();
  const description = String(event.description || '').trim();
  const startDate = String(event.startDate || '').trim();
  const endDate = String(event.endDate || '').trim();

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

  if (!name) {
    return {
      status: 'invalid_params',
      message: '评分活动名称不能为空'
    };
  }

  if (startDate && endDate && startDate > endDate) {
    return {
      status: 'invalid_params',
      message: '活动开始时间不能晚于结束时间'
    };
  }

  const payload = {
    name,
    description,
    startDate,
    endDate,
    updatedAt: db.serverDate(),
    updatedBy: operator.data[0]._id
  };

  if (id) {
    await db.collection('score_activities')
      .doc(id)
      .update({
        data: payload
      });
  } else {
    const existing = await db.collection('score_activities')
      .where({
        name
      })
      .limit(1)
      .get();

    if (existing.data.length) {
      await db.collection('score_activities')
        .doc(existing.data[0]._id)
        .update({
          data: payload
        });
    } else {
      await db.collection('score_activities').add({
        data: {
          ...payload,
          isCurrent: false,
          createdAt: db.serverDate(),
          createdBy: operator.data[0]._id
        }
      });
    }
  }

  return {
    status: 'success'
  };
};
