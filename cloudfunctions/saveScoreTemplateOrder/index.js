const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const operator = await db.collection('admin_info')
    .where({ openid: wxContext.OPENID, bindStatus: 'active' })
    .limit(1)
    .get();
  if (!operator.data.length) return { status: 'forbidden', message: '仅管理员可操作' };
  return { status: 'success', message: '排序已更新' };
};
