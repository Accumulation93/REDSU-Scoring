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
      status: 'forbidden'
    };
  }

  if (!id) {
    return {
      status: 'invalid_params'
    };
  }

  const hrDoc = await db.collection('hr_info').doc(id).get();
  const studentId = hrDoc.data['学号'] || hrDoc.data.studentId || '';

  await db.collection('hr_info')
    .doc(id)
    .remove();

  if (studentId) {
    const userRes = await db.collection('user_info')
      .where({
        studentId
      })
      .get();

    for (const item of userRes.data) {
      await db.collection('user_info')
        .doc(item._id)
        .remove();
    }
  }

  return {
    status: 'success'
  };
};
