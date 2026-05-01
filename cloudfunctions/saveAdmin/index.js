const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function safeString(value) { return String(value == null ? '' : value).trim(); }

async function ensureInviteCodeAvailable(inviteCode, excludeId = '') {
  const res = await db.collection('admin_info').where({ inviteCode }).limit(1).get();
  if (!res.data.length) return true;
  return res.data[0]._id === excludeId;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = safeString(event.id);
  const name = safeString(event.name);
  const studentId = safeString(event.studentId);
  const adminLevel = safeString(event.adminLevel || 'admin');
  const inviteCode = safeString(event.inviteCode).toUpperCase();

  const operator = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  if (!operator.data.length) return { status: 'forbidden', message: '没有管理员权限' };

  const operatorLevel = operator.data[0].adminLevel || 'admin';
  if (!name || !studentId) return { status: 'invalid_params', message: '请填写姓名和学号' };
  if (!['admin', 'super_admin', 'root_admin'].includes(adminLevel)) return { status: 'invalid_params', message: '无效的管理员级别' };
  if (!inviteCode) return { status: 'invalid_params', message: '请填写邀请码' };

  if (operatorLevel !== 'root_admin' && adminLevel === 'root_admin') {
    return { status: 'forbidden', message: '仅至高权限管理员可添加至高权限管理员' };
  }

  const available = await ensureInviteCodeAvailable(inviteCode, id);
  if (!available) return { status: 'duplicate_invite_code', message: '邀请码已被使用' };

  const payload = {
    name,
    studentId,
    adminLevel,
    inviteCode
  };

  if (id) {
    const existing = await db.collection('admin_info').doc(id).get().catch(() => ({ data: null }));
    const targetDoc = existing.data;
    if (!targetDoc) return { status: 'not_found', message: '管理员不存在' };
    if (targetDoc.adminLevel === 'root_admin' && adminLevel !== 'root_admin') {
      const rootAdminRes = await db.collection('admin_info').where({ adminLevel: 'root_admin' }).get();
      if (rootAdminRes.data.length <= 1) return { status: 'invalid_operation', message: '不能降级唯一的至高权限管理员' };
    }
    await db.collection('admin_info').doc(id).update({ data: payload });
  } else {
    const existing = await db.collection('admin_info').where({ studentId }).limit(1).get();
    const createPayload = { name, studentId, adminLevel, inviteCode, bindStatus: 'invited', openid: '', invitedAt: db.serverDate() };
    if (existing.data.length) await db.collection('admin_info').doc(existing.data[0]._id).update({ data: { ...payload, bindStatus: 'invited', openid: '', invitedAt: db.serverDate() } });
    else await db.collection('admin_info').add({ data: createPayload });
  }

  return { status: 'success', inviteCode };
};
