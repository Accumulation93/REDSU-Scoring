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

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const onlyGenerate = !!event.onlyGenerate;
  const name = String(event.name || '').trim();
  const studentId = String(event.studentId || '').trim();
  const adminLevel = String(event.adminLevel || 'admin').trim();

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

  if (operatorLevel !== 'root_admin' && adminLevel === 'root_admin') {
    return {
      status: 'forbidden',
      message: '仅至高权限管理员可邀请至高权限管理员'
    };
  }

  if (onlyGenerate) {
    return {
      status: 'success',
      inviteCode: await generateUniqueCode()
    };
  }

  if (!name || !studentId || !adminLevel) {
    return {
      status: 'invalid_params',
      message: '请提供姓名、学号和管理员类别'
    };
  }

  if (['root_admin', 'super_admin', 'admin'].indexOf(adminLevel) === -1) {
    return {
      status: 'invalid_params',
      message: '管理员类别只能是 root_admin、super_admin 或 admin'
    };
  }

  const hrRes = await db.collection('hr_info')
    .where({ studentId })
    .limit(1)
    .get();

  if (!hrRes.data.length || String(hrRes.data[0].name || '') !== name) {
    return {
      status: 'invalid_params',
      message: '请从人事成员中选择有效成员'
    };
  }

  const inviteCode = await generateUniqueCode();
  const existing = await db.collection('admin_info')
    .where({ studentId })
    .limit(1)
    .get();

  const payload = {
    name,
    studentId,
    adminLevel,
    inviteCode,
    bindStatus: 'invited',
    invitedBy: operatorRes.data[0]._id,
    invitedAt: db.serverDate()
  };

  if (existing.data.length) {
    await db.collection('admin_info').doc(existing.data[0]._id).update({
      data: {
        ...payload,
        openid: ''
      }
    });
  } else {
    await db.collection('admin_info').add({
      data: {
        ...payload,
        openid: ''
      }
    });
  }

  return {
    status: 'success',
    inviteCode,
    adminLevel
  };
};
