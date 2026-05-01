const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const operator = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active', adminLevel: 'root_admin' })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return { status: 'forbidden', message: '仅至高权限管理员可操作' };
  }

  const id = safeString(event.id);
  const name = safeString(event.name);

  if (!name) {
    return { status: 'invalid_params', message: '请填写组织名称' };
  }

  if (id) {
    const existing = await db.collection('organizations').doc(id).get().catch(() => ({ data: null }));
    if (!existing.data) {
      return { status: 'not_found', message: '组织不存在' };
    }
    await db.collection('organizations').doc(id).update({
      data: { name }
    });
    return { status: 'success', organization: { id, name } };
  }

  const addRes = await db.collection('organizations').add({
    data: {
      name,
      createdAt: db.serverDate()
    }
  });

  return {
    status: 'success',
    organization: {
      id: addRes._id,
      name
    }
  };
};
