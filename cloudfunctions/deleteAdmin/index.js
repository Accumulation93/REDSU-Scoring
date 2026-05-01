const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();

  const operator = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active',
      adminLevel: 'root_admin'
    })
    .limit(1)
    .get();

  if (!operator.data.length) {
    return {
      status: 'forbidden',
      message: '只有至高权限管理员可以删除管理员'
    };
  }

  if (!id) {
    return {
      status: 'invalid_params'
    };
  }

  const target = await db.collection('admin_info').doc(id).get();

  if (target.data.adminLevel === 'root_admin') {
    const rootAdminRes = await db.collection('admin_info')
      .where({
        adminLevel: 'root_admin'
      })
      .get();

    if (rootAdminRes.data.length <= 1) {
      return {
        status: 'invalid_operation',
        message: '数据库中至少还要有一个至高权限管理员'
      };
    }
  }

  await db.collection('admin_info')
    .doc(id)
    .remove();

  return {
    status: 'success'
  };
};
