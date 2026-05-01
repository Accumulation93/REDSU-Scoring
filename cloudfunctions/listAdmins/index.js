const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function getLevelLabel(adminLevel) {
  if (adminLevel === 'root_admin') return '至高权限管理员';
  if (adminLevel === 'super_admin') return '超级管理员';
  return '普通管理员';
}

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

  let query;
  if (operatorLevel === 'root_admin') {
    query = db.collection('admin_info');
  } else if (operatorLevel === 'super_admin') {
    query = db.collection('admin_info').where({
      adminLevel: db.command.in(['super_admin', 'admin'])
    });
  } else {
    query = db.collection('admin_info').where({ adminLevel: 'admin' });
  }

  const res = await query.limit(1000).get();
  const list = res.data.map((item) => {
    const adminLevel = item.adminLevel || 'admin';
    return {
      id: item._id,
      name: item.name || '',
      studentId: item.studentId || '',
      adminLevel,
      adminLevelLabel: getLevelLabel(adminLevel),
      inviteCode: item.inviteCode || '',
      bindStatus: item.bindStatus || ''
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return {
    status: 'success',
    list,
    canManage: operatorLevel === 'root_admin' || operatorLevel === 'super_admin'
  };
};
