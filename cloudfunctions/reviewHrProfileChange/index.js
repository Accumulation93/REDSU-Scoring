const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const studentId = String(event.studentId || '').trim();
  const action = String(event.action || '').trim();
  const reason = String(event.reason || '').trim();

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
      message: '没有管理员权限'
    };
  }

  if (!studentId || ['approve', 'reject'].indexOf(action) === -1) {
    return {
      status: 'invalid_params',
      message: '审核参数不合法'
    };
  }

  const recordRes = await db.collection('hr_profile_records')
    .where({
      studentId
    })
    .limit(1)
    .get();

  if (!recordRes.data.length) {
    return {
      status: 'not_found',
      message: '未找到对应的人事信息记录'
    };
  }

  const record = recordRes.data[0];
  const pendingValues = record.pendingValues && typeof record.pendingValues === 'object' ? record.pendingValues : {};
  if (!Object.keys(pendingValues).length) {
    return {
      status: 'invalid_operation',
      message: '当前没有待审核的修改'
    };
  }

  const nextPayload = action === 'approve'
    ? {
      values: pendingValues,
      pendingValues: {},
      auditStatus: 'approved',
      rejectionReason: '',
      reviewedAt: db.serverDate(),
      reviewedBy: operator.data[0]._id,
      updatedAt: db.serverDate()
    }
    : {
      pendingValues: {},
      auditStatus: 'rejected',
      rejectionReason: reason || '管理员已驳回本次修改',
      reviewedAt: db.serverDate(),
      reviewedBy: operator.data[0]._id,
      updatedAt: db.serverDate()
    };

  await db.collection('hr_profile_records')
    .doc(record._id)
    .update({
      data: nextPayload
    });

  return {
    status: 'success'
  };
};
