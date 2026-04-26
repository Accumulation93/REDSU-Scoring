const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const CACHE_META_COLLECTIONS = ['score_results_cache_meta', 'scorer_task_cache_meta'];
const VALID_SCOPES = [
  'same_department_identity',
  'same_department_all',
  'same_work_group_identity',
  'same_work_group_all',
  'identity_only',
  'all_people'
];

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

function toBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeTemplateConfigs(clause = {}) {
  if (Array.isArray(clause.templateConfigs)) {
    return clause.templateConfigs;
  }
  if (clause.templateId) {
    return [{
      templateId: clause.templateId,
      templateName: clause.templateName || '',
      weight: clause.weight == null ? 1 : clause.weight,
      sortOrder: clause.sortOrder == null ? 1 : clause.sortOrder
    }];
  }
  return [];
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const id = safeString(event.id);
  const activityId = safeString(event.activityId);
  const activityName = safeString(event.activityName);
  const scorerDepartment = safeString(event.scorerDepartment);
  const scorerIdentity = safeString(event.scorerIdentity);
  const clauses = Array.isArray(event.clauses) ? event.clauses : [];

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

  if (!activityId || !scorerDepartment || !scorerIdentity) {
    return {
      status: 'invalid_params',
      message: '请提供完整的评分活动和评分人类别'
    };
  }

  const activityRes = await db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null }));
  if (!activityRes.data) {
    return {
      status: 'invalid_params',
      message: '所选评分活动不存在'
    };
  }

  const normalizedClauses = [];
  for (const clause of clauses) {
    const scopeType = safeString(clause.scopeType);
    const targetIdentity = safeString(clause.targetIdentity);
    if (!VALID_SCOPES.includes(scopeType)) {
      continue;
    }
    if (
      scopeType !== 'all_people'
      && scopeType !== 'same_department_all'
      && scopeType !== 'same_work_group_all'
      && !targetIdentity
    ) {
      continue;
    }

    const rawTemplateConfigs = normalizeTemplateConfigs(clause);
    const templateConfigs = [];
    for (const item of rawTemplateConfigs) {
      const templateId = safeString(item.templateId);
      if (!templateId) {
        continue;
      }
      const templateRes = await db.collection('score_question_templates').doc(templateId).get().catch(() => ({ data: null }));
      if (!templateRes.data) {
        return {
          status: 'invalid_params',
          message: '所选评分问题不存在'
        };
      }
      const weight = Number(item.weight);
      const sortOrder = Number(item.sortOrder);
      if (!Number.isFinite(weight) || weight <= 0 || !Number.isInteger(sortOrder) || sortOrder <= 0) {
        continue;
      }
      templateConfigs.push({
        templateId,
        templateName: safeString(templateRes.data.name || item.templateName),
        weight,
        sortOrder
      });
    }

    templateConfigs.sort((a, b) => a.sortOrder - b.sortOrder);
    normalizedClauses.push({
      scopeType,
      targetIdentity,
      requireAllComplete: toBoolean(clause.requireAllComplete),
      templateConfigs
    });
  }

  const payload = {
    activityId,
    activityName: safeString(activityRes.data.name || activityName),
    scorerKey: `${scorerDepartment}::${scorerIdentity}`,
    scorerDepartment,
    scorerIdentity,
    clauses: normalizedClauses,
    isActive: true,
    updatedAt: db.serverDate()
  };

  if (id) {
    await db.collection('rate_target_rules').doc(id).update({
      data: payload
    });
  } else {
    const existing = await db.collection('rate_target_rules')
      .where({
        activityId,
        scorerKey: payload.scorerKey
      })
      .limit(1)
      .get();

    if (existing.data.length) {
      await db.collection('rate_target_rules').doc(existing.data[0]._id).update({
        data: payload
      });
    } else {
      await db.collection('rate_target_rules').add({
        data: {
          ...payload,
          createdAt: db.serverDate()
        }
      });
    }
  }

  await invalidateActivityCaches(activityId);

  return {
    status: 'success'
  };
};
