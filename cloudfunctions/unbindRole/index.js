const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const role = String(event.role || '').trim();

  if (role === 'user') {
    const res = await db.collection('user_info')
      .where({ openid })
      .get();

    if (!res.data.length) {
      return {
        status: 'already_unbound'
      };
    }

    await Promise.all(
      res.data.map((item) =>
        db.collection('user_info').doc(item._id).remove()
      )
    );

    return {
      status: 'unbind_success'
    };
  }

  if (role === 'admin') {
    const res = await db.collection('admin_info')
      .where({
        openid,
        bindStatus: 'active'
      })
      .limit(1)
      .get();

    if (!res.data.length) {
      return {
        status: 'already_unbound'
      };
    }

    await db.collection('admin_info')
      .doc(res.data[0]._id)
      .update({
        data: {
          openid: '',
          bindStatus: 'invited'
        }
      });

    return {
      status: 'unbind_success'
    };
  }

  return {
    status: 'invalid_role'
  };
};
