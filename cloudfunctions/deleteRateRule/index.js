const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = safeString(event.id);

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

  if (!id) {
    return {
      status: 'invalid_params'
    };
  }

  const ruleRes = await db.collection('rate_target_rules').doc(id).get().catch(() => ({ data: null }));

  await db.collection('rate_target_rules')
    .doc(id)
    .remove();

  return {
    status: 'success'
  };
};
