const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CACHE_META_COLLECTIONS = ['score_results_cache_meta', 'scorer_task_cache_meta'];

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

async function runInBatches(items, handler, batchSize = 20) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map((item) => handler(item)));
  }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const activityId = String(event.activityId || '').trim();

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
      message: '没有管理权限'
    };
  }

  if (!activityId) {
    return {
      status: 'invalid_params',
      message: '请先选择评分活动'
    };
  }

  const activityRes = await db.collection('score_activities')
    .doc(activityId)
    .get();

  if (!activityRes.data) {
    return {
      status: 'invalid_params',
      message: '评分活动不存在'
    };
  }

  const [hrRes, existingRulesRes] = await Promise.all([
    db.collection('hr_info').limit(1000).get(),
    db.collection('rate_target_rules').where({ activityId }).limit(1000).get()
  ]);

  const uniqueCategoryMap = new Map();
  (hrRes.data || []).forEach((item) => {
    const department = String(item['所属部门'] || '').trim();
    const identity = String(item['身份'] || '').trim();
    if (!department || !identity) {
      return;
    }

    const scorerKey = `${department}::${identity}`;
    if (!uniqueCategoryMap.has(scorerKey)) {
      uniqueCategoryMap.set(scorerKey, {
        activityId,
        activityName: activityRes.data.name || '',
        scorerKey,
        scorerDepartment: department,
        scorerIdentity: identity,
        clauses: [],
        isActive: true
      });
    }
  });

  const existingRuleMap = new Map();
  const duplicateRuleIds = [];
  (existingRulesRes.data || []).forEach((item) => {
    const scorerKey = String(item.scorerKey || '').trim();
    if (!scorerKey) {
      duplicateRuleIds.push(item._id);
      return;
    }

    if (!existingRuleMap.has(scorerKey)) {
      existingRuleMap.set(scorerKey, item);
    } else {
      duplicateRuleIds.push(item._id);
    }
  });

  const rulesToAdd = [];
  for (const rule of uniqueCategoryMap.values()) {
    if (!existingRuleMap.has(rule.scorerKey)) {
      rulesToAdd.push(rule);
    }
  }

  await runInBatches(duplicateRuleIds, (id) => (
    db.collection('rate_target_rules').doc(id).remove()
  ));

  await runInBatches(rulesToAdd, (rule) => (
    db.collection('rate_target_rules').add({
      data: {
        ...rule,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
  ));

  await invalidateActivityCaches(activityId);

  return {
    status: 'success',
    collectionName: 'rate_target_rules',
    ruleCount: uniqueCategoryMap.size,
    createdCount: rulesToAdd.length,
    keptCount: uniqueCategoryMap.size - rulesToAdd.length,
    removedDuplicateCount: duplicateRuleIds.length
  };
};
