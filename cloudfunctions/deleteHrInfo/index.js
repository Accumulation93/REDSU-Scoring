const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CACHE_META_COLLECTIONS = ['score_results_cache_meta', 'scorer_task_cache_meta'];

async function invalidateAllScoreCaches() {
  for (const collectionName of CACHE_META_COLLECTIONS) {
    while (true) {
      const res = await db.collection(collectionName)
        .where({ isInvalid: false })
        .limit(100)
        .get()
        .catch(() => ({ data: [] }));
      const rows = res.data || [];
      if (!rows.length) {
        break;
      }
      await Promise.all(rows.map((item) => (
        db.collection(collectionName).doc(item._id).update({
          data: {
            isInvalid: true,
            invalidatedAt: db.serverDate()
          }
        }).catch(() => null)
      )));
      if (rows.length < 100) {
        break;
      }
    }
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = String(event.id || '').trim();

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

  const hrDoc = await db.collection('hr_info').doc(id).get();
  const studentId = hrDoc.data['学号'] || hrDoc.data.studentId || '';

  await db.collection('hr_info')
    .doc(id)
    .remove();

  if (studentId) {
    const userRes = await db.collection('user_info')
      .where({
        studentId
      })
      .get();

    for (const item of userRes.data) {
      await db.collection('user_info')
        .doc(item._id)
        .remove();
    }
  }

  await invalidateAllScoreCaches();

  return {
    status: 'success'
  };
};
