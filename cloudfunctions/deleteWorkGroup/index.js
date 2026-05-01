const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const id = safeString(event.id);
    if (!id) return { status: 'invalid_params', message: '工作分工ID不能为空' };
    const admin = await ensureAdmin(wxContext.OPENID);
    if (!admin) return { status: 'forbidden', message: '没有管理权限' };

    const current = await db.collection('work_groups').doc(id).get().catch(() => ({ data: null }));
    if (!current.data) return { status: 'not_found', message: '工作分工不存在' };

    const hrRes = await db.collection('hr_info').where({ workGroupId: id }).limit(1).get().catch(() => ({ data: [] }));
    if ((hrRes.data || []).length) return { status: 'in_use', message: '该工作分工已被人事成员引用，不能删除' };

    await db.collection('work_groups').doc(id).remove();
    return { status: 'success', message: '工作分工删除成功' };
  } catch (error) {
    return { status: 'error', message: safeString(error && (error.message || error.errMsg)) || '删除工作分工失败' };
  }
};
