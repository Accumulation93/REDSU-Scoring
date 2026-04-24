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
      bindStatus: 'active',
      adminLevel: 'super_admin'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return {
      status: 'forbidden',
      message: '只有超级管理员可以导出管理员信息'
    };
  }

  const res = await db.collection('admin_info').limit(1000).get();
  const list = res.data.sort((a, b) => {
    const nameA = a.name || a['姓名'] || '';
    const nameB = b.name || b['姓名'] || '';
    return nameA.localeCompare(nameB, 'zh-CN');
  });

  const lines = [
    ['姓名', '学号', '类别', '邀请码', '绑定状态'].join(',')
  ];

  list.forEach((item) => {
    const adminLevel = item.adminLevel === 'super_admin' ? '超级管理员' : '普通管理员';
    lines.push([
      escapeCsv(item.name || item['姓名'] || ''),
      escapeCsv(item.studentId || item['学号'] || ''),
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
