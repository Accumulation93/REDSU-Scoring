const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CACHE_META_COLLECTIONS = ['score_results_cache_meta', 'scorer_task_cache_meta'];

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

async function invalidateActivityCaches(activityId) {
  if (!activityId) {
    return;
  }
  await Promise.all(CACHE_META_COLLECTIONS.map((collectionName) => (
    db.collection(collectionName)
      .where({ activityId })
      .update({
        data: {
          isInvalid: true,
          invalidatedAt: db.serverDate()
        }
      })
      .catch(() => null)
  )));
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({
      openid,
      bindStatus: 'active'
    })
    .limit(1)
    .get();
  return res.data[0] || null;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const recordId = safeString(event.recordId);

  if (!recordId) {
    return {
      status: 'invalid_params',
      message: '缺少评分记录标识'
    };
  }

  const admin = await ensureAdmin(openid);
  if (!admin) {
    return {
      status: 'forbidden',
      message: '没有管理权限'
    };
  }

  const recordRes = await db.collection('score_records').doc(recordId).get().catch(() => ({ data: null }));
  if (!recordRes.data) {
    return {
      status: 'not_found',
      message: '评分记录不存在'
    };
  }

  await db.collection('score_records').doc(recordId).remove();
  await invalidateActivityCaches(safeString(recordRes.data.activityId));
  return {
    status: 'success',
    message: '评分记录已撤销'
  };
};
