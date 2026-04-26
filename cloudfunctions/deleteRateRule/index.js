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

  await invalidateActivityCaches(safeString(ruleRes.data && ruleRes.data.activityId));

  return {
    status: 'success'
  };
};
