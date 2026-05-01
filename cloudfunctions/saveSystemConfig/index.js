const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const CONFIG_ID = 'default';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext();
  const adminRes = await db.collection('admin_info')
    .where({ openid: wxContext.OPENID, bindStatus: 'active' })
    .limit(1)
    .get();

  if (!adminRes.data.length) {
    return { status: 'forbidden', message: '无管理权限' };
  }

  const timezone = Number(event.timezone);
  if (!Number.isInteger(timezone) || timezone < -12 || timezone > 14) {
    return { status: 'invalid_params', message: '时区参数无效，请输入 -12 到 14 的整数' };
  }

  const existing = await db.collection('system_config').doc(CONFIG_ID).get().catch(() => ({ data: null }));

  const updateData = { timezone, updatedAt: db.serverDate() };

  if (existing.data) {
    await db.collection('system_config').doc(CONFIG_ID).update({
      data: updateData
    });
  } else {
    await db.collection('system_config').add({
      data: {
        _id: CONFIG_ID,
        timezone,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
  }

  return { status: 'success', config: { timezone } };
};
