const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

async function ensureInviteCodeAvailable(inviteCode, excludeId = '') {
  const res = await db.collection('admin_info')
    .where({ inviteCode })
    .limit(1)
    .get();

  if (!res.data.length) {
    return true;
  }

  return res.data[0]._id === excludeId;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();
  const name = String(event.name || '').trim();
  const studentId = String(event.studentId || '').trim();
  const adminLevel = String(event.adminLevel || 'admin').trim();
  const inviteCode = String(event.inviteCode || '').trim().toUpperCase();

  const operator = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active',
      adminLevel: 'super_admin'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return {
      status: 'forbidden',
      message: '只有超级管理员可以管理管理员信息'
    };
  }

  if (!name || !studentId) {
    return {
      status: 'invalid_params',
      message: '姓名和学号必填'
    };
  }

  if (['admin', 'super_admin'].indexOf(adminLevel) === -1) {
    return {
      status: 'invalid_params',
      message: '管理员类型不合法'
    };
  }

  if (!inviteCode) {
    return {
      status: 'invalid_params',
      message: '邀请码不能为空'
    };
  }

  if (id) {
    const existing = await db.collection('admin_info').doc(id).get();
    const targetDoc = existing.data;

    if (!targetDoc) {
      return {
        status: 'not_found',
        message: '管理员记录不存在'
      };
    }

    if (targetDoc.adminLevel === 'super_admin' && adminLevel !== 'super_admin') {
      const superAdminRes = await db.collection('admin_info')
        .where({ adminLevel: 'super_admin' })
        .get();

      if (superAdminRes.data.length <= 1) {
        return {
          status: 'invalid_operation',
          message: '数据库中至少要保留一个超级管理员'
        };
      }
    }

    const available = await ensureInviteCodeAvailable(inviteCode, id);
    if (!available) {
      return {
        status: 'duplicate_invite_code',
        message: '邀请码已被其他管理员使用'
      };
    }

    await db.collection('admin_info')
      .doc(id)
      .update({
        data: {
          姓名: name,
          学号: studentId,
          name,
          studentId,
          adminLevel,
          inviteCode
        }
      });
  } else {
    const available = await ensureInviteCodeAvailable(inviteCode);
    if (!available) {
      return {
        status: 'duplicate_invite_code',
        message: '邀请码已被其他管理员使用'
      };
    }

    const existing = await db.collection('admin_info')
      .where({ 学号: studentId })
      .limit(1)
      .get();

    const payload = {
      姓名: name,
      学号: studentId,
      name,
      studentId,
      adminLevel,
      inviteCode,
      bindStatus: 'invited',
      openid: '',
      invitedAt: db.serverDate()
    };

    if (existing.data.length) {
      await db.collection('admin_info')
        .doc(existing.data[0]._id)
        .update({ data: payload });
    } else {
      await db.collection('admin_info').add({ data: payload });
    }
  }

  return {
    status: 'success',
    inviteCode
  };
};
