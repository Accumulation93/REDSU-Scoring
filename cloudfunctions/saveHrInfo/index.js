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
  const studentId = String(event.studentId || '').trim();
  const department = String(event.department || '').trim();
  const identity = String(event.identity || '').trim();
  const workGroup = String(event.workGroup || '').trim();

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

  if (!name || !studentId || !department || !identity) {
    return {
      status: 'invalid_params',
      message: '姓名、学号、所属部门和身份为必填项'
    };
  }

  const payload = {
    姓名: name,
    学号: studentId,
    所属部门: department,
    身份: identity,
    '工作分工（职能组）': workGroup,
    name,
    studentId,
    department,
    identity,
    workGroup
  };

  if (id) {
    await db.collection('hr_info')
      .doc(id)
      .update({
        data: payload
      });
  } else {
    const existing = await db.collection('hr_info')
      .where({
        学号: studentId
      })
      .limit(1)
      .get();

    if (existing.data.length) {
      await db.collection('hr_info')
        .doc(existing.data[0]._id)
        .update({
          data: payload
        });
    } else {
      await db.collection('hr_info').add({
        data: payload
      });
    }
  }

  return {
    status: 'success'
  };
};
