const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async () => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

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
      message: '没有管理权限'
    };
  }

  const res = await db.collection('score_activities')
    .limit(1000)
    .get();

  const list = res.data.map((item) => ({
    id: item._id,
    name: item.name || '',
    description: item.description || '',
    startDate: item.startDate || '',
    endDate: item.endDate || '',
    isCurrent: !!item.isCurrent,
    updatedAt: item.updatedAt || null
  })).sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1;
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });

  return {
    status: 'success',
    list,
    currentActivityId: (list.find((item) => item.isCurrent) || {}).id || ''
  };
};
