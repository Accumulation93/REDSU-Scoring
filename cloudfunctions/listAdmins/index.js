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
      message: '没有管理员权限'
    };
  }

  const operatorLevel = operator.data[0].adminLevel || 'admin';
  const query = operatorLevel === 'super_admin'
    ? db.collection('admin_info')
    : db.collection('admin_info').where({ adminLevel: 'admin' });

  const res = await query.limit(1000).get();
  const list = res.data.map((item) => {
    const adminLevel = item.adminLevel || 'admin';
    return {
      id: item._id,
      name: item.name || item['姓名'] || '',
      studentId: item.studentId || item['学号'] || '',
      adminLevel,
      adminLevelLabel: adminLevel === 'super_admin' ? '超级管理员' : '普通管理员',
      inviteCode: item.inviteCode || '',
      bindStatus: item.bindStatus || ''
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return {
    status: 'success',
    list,
    canManage: operatorLevel === 'super_admin'
  };
};
