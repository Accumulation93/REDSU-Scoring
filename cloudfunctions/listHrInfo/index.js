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
      status: 'forbidden'
    };
  }

  const res = await db.collection('hr_info').limit(1000).get();
  const list = res.data.map((item) => ({
    id: item._id,
    name: item.name || item['姓名'] || '',
    studentId: item.studentId || item['学号'] || '',
    department: item.department || item['所属部门'] || '',
    identity: item.identity || item['身份'] || '',
    workGroup: item.workGroup || item['工作分工（职能组）'] || ''
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return {
    status: 'success',
    list
  };
};
