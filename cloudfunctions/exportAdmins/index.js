const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function escapeCsv(value) {
  const text = String(value == null ? '' : value);
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
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
  if (operatorLevel !== 'root_admin' && operatorLevel !== 'super_admin') {
    return {
      status: 'forbidden',
      message: '仅至高权限管理员或超级管理员可以导出管理员信息'
    };
  }

  const res = await db.collection('admin_info').limit(1000).get();
  const list = res.data.sort((a, b) => {
    const nameA = a.name || '';
    const nameB = b.name || '';
    return nameA.localeCompare(nameB, 'zh-CN');
  });

  const lines = [
    ['姓名', '学号', '类别', '邀请码', '绑定状态'].join(',')
  ];

  list.forEach((item) => {
    const adminLevel = item.adminLevel === 'root_admin' ? '至高权限管理员' : (item.adminLevel === 'super_admin' ? '超级管理员' : '普通管理员');
    lines.push([
      escapeCsv(item.name || ''),
      escapeCsv(item.studentId || ''),
      escapeCsv(adminLevel),
      escapeCsv(item.inviteCode || ''),
      escapeCsv(item.bindStatus || '')
    ].join(','));
  });

  return {
    status: 'success',
    fileName: `admin_info_export_${Date.now()}.csv`,
    csvContent: `\uFEFF${lines.join('\n')}`
  };
};
