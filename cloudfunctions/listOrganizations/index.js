const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const operator = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return { status: 'forbidden', message: '没有管理员权限' };
  }

  const res = await db.collection('organizations').limit(500).get();
  const list = (res.data || [])
    .map((item) => ({
      id: item._id,
      name: item.name || '',
      createdAt: item.createdAt
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));

  return { status: 'success', list };
};
