const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function safeString(value) { return String(value == null ? '' : value).trim(); }

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info').where({ openid, bindStatus: 'active' }).limit(1).get();
  return res.data[0] || null;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const admin = await ensureAdmin(wxContext.OPENID);
    if (!admin) return { status: 'forbidden', message: '无管理权限' };

    const id = safeString(event.id);
    const name = safeString(event.name);
    const description = safeString(event.description);
    if (!name) return { status: 'invalid_params', message: '请填写身份名称' };

    const duplicate = await db.collection('identities').where({ name }).limit(10).get().catch(() => ({ data: [] }));
    if ((duplicate.data || []).some((item) => safeString(item._id) !== id)) {
      return { status: 'invalid_params', message: '身份名称重复' };
    }

    const now = db.serverDate();
    const data = {
      name,
      description,
      code: _.remove(),
      sortOrder: _.remove(),
      updatedAt: now
    };

    if (id) {
      const current = await db.collection('identities').doc(id).get().catch(() => ({ data: null }));
      if (!current.data) return { status: 'not_found', message: '身份不存在' };
      await db.collection('identities').doc(id).update({ data });
      return { status: 'success', id };
    }

    const addRes = await db.collection('identities').add({ data: { name, description, createdAt: now, updatedAt: now } });
    return { status: 'success', id: addRes._id };
  } catch (error) {
    return { status: 'error', message: safeString(error && (error.message || error.errMsg)) || '保存身份失败' };
  }
};
