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

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const name = String(event.name || '').trim();
  const studentId = String(event.studentId || '').trim();

  if (!name || !studentId) {
    return {
      status: 'invalid_params'
    };
  }

  const hrRes = await db.collection('hr_info')
    .where({
      姓名: name
    })
    .limit(100)
    .get();

  const match = hrRes.data.find((item) => String(item['学号']) === studentId);

  if (!match) {
    return {
      status: 'bind_failed'
    };
  }

  const payload = {
    openid,
    name: match['姓名'],
    studentId: match['学号'],
    department: match['所属部门'] || '',
    identity: match['身份'] || '',
    workGroup: match['工作分工（职能组）'] || ''
  };

  const existing = await db.collection('user_info')
    .where({ openid })
    .limit(1)
    .get();

  if (existing.data.length > 0) {
    await db.collection('user_info')
      .doc(existing.data[0]._id)
      .update({
        data: payload
      });
  } else {
    await db.collection('user_info').add({
      data: payload
    });
  }

  return {
    status: 'bind_success',
    user: normalizeUser(payload)
  };
};
