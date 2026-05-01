const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
function safeString(value) {
  return String(value == null ? '' : value).trim();
}
const PROFILE_COLLECTION_MAP = {
  user: 'user_info',
  admin: 'admin_info'
};

const PAGE_SIZE = 100;

async function getAllRecords(query) {
  const list = [];
  let skip = 0;
  while (true) {
    const res = await query.where({}).skip(skip).limit(PAGE_SIZE).get().catch(() => ({ data: [] }));
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += batch.length;
  }
  return list;
}

function buildNameMap(rows = []) {
  const map = new Map();
  rows.forEach((item) => {
    const id = String(item && item._id || '').trim();
    if (id) map.set(id, String(item.name || '').trim());
  });
  return map;
}

async function fetchOrgLookups() {
  const [departments, identities, workGroups] = await Promise.all([
    getAllRecords(db.collection('departments')),
    getAllRecords(db.collection('identities')),
    getAllRecords(db.collection('work_groups'))
  ]);
  return {
    departmentsById: buildNameMap(departments),
    identitiesById: buildNameMap(identities),
    workGroupsById: buildNameMap(workGroups)
  };
}

function normalizePerson(record = {}, lookups = {}) {
  const departmentId = safeString(record.departmentId);
  const identityId = safeString(record.identityId);
  const workGroupId = safeString(record.workGroupId);

  return {
    id: safeString(record._id),
    name: safeString(record.name),
    studentId: safeString(record.studentId),
    departmentId,
    department: safeString(lookups.departmentsById && lookups.departmentsById.get(departmentId)),
    identityId,
    identity: safeString(lookups.identitiesById && lookups.identitiesById.get(identityId)),
    workGroupId,
    workGroup: safeString(lookups.workGroupsById && lookups.workGroupsById.get(workGroupId)),
    adminLevel: safeString(record.adminLevel)
  };
}

function getRuleKey(person) {
  const departmentId = String(person.departmentId || '').trim();
  const identityId = String(person.identityId || '').trim();
  return departmentId && identityId ? departmentId + '::' + identityId : '';
}

async function fetchCurrentActivity() {
  const res = await db.collection('score_activities')
    .where({
      isCurrent: true
    })
    .limit(1)
    .get();

  return res.data.length ? res.data[0] : null;
}

async function enrichScorer(profileCollection, profileDoc, lookups) {
  const profile = normalizePerson(profileDoc, lookups);
  if (profileCollection === 'admin_info') {
    return {
      ...profile,
      identity: profile.adminLevel === 'root_admin' ? '至高权限管理员' : (profile.adminLevel === 'super_admin' ? '超级管理员' : '管理员')
    };
  }
  return profile;
}

function normalizeClause(clause = {}) {
  return {
    scopeType: safeString(clause.scopeType),
    targetIdentityId: safeString(clause.targetIdentityId),
    templateConfigs: Array.isArray(clause.templateConfigs) ? clause.templateConfigs : []
  };
}

async function fetchClauseTargets(scorer, clause) {
  const where = {};
  if (clause.scopeType === 'same_department_identity') {
    where.departmentId = scorer.departmentId;
    where.identityId = clause.targetIdentityId;
  } else if (clause.scopeType === 'same_department_all') {
    where.departmentId = scorer.departmentId;
  } else if (clause.scopeType === 'same_work_group_identity') {
    where.departmentId = scorer.departmentId;
    where.workGroupId = scorer.workGroupId;
    where.identityId = clause.targetIdentityId;
  } else if (clause.scopeType === 'same_work_group_all') {
    where.departmentId = scorer.departmentId;
    where.workGroupId = scorer.workGroupId;
  } else if (clause.scopeType === 'identity_only') {
    where.identityId = clause.targetIdentityId;
  } else if (clause.scopeType === 'all_people') {
    return db.collection('hr_info').limit(1000).get();
  } else {
    return { data: [] };
  }
  return db.collection('hr_info').where(where).limit(1000).get();
}

async function getScoredTargetIdSet(scorerId, activityId) {
  const where = activityId
    ? { scorerId, activityId }
    : { scorerId };

  const scoreRes = await db.collection('score_records')
    .where(where)
    .limit(1000)
    .get();

  return new Set((scoreRes.data || []).map((item) => item.targetId).filter(Boolean));
}

async function getScoredTargetIdSetByScorer(scorer, openid, activityId) {
  const resultSet = new Set();
  const queries = [];

  if (scorer.id) {
    queries.push(activityId ? { scorerId: scorer.id, activityId } : { scorerId: scorer.id });
  }

  if (openid) {
    queries.push(activityId ? { openid, activityId } : { openid });
  }


  for (const where of queries) {
    const scoreRes = await db.collection('score_records')
      .where(where)
      .limit(1000)
      .get();

    (scoreRes.data || []).forEach((item) => {
      if (item.targetId) {
        resultSet.add(item.targetId);
      }
    });
  }

  return resultSet;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const role = String(event.role || 'user').trim();
  const profileCollection = PROFILE_COLLECTION_MAP[role] || PROFILE_COLLECTION_MAP.user;

  const where = role === 'admin'
    ? { openid, bindStatus: 'active' }
    : { openid };

    const orgLookups = await fetchOrgLookups();

    let scorerRaw = null;
    
    if (role === 'admin') {
      const adminRes = await db.collection('admin_info')
        .where({ openid, bindStatus: 'active' })
        .limit(1)
        .get();
    
      if (!adminRes.data.length) {
        return {
          status: 'need_bind',
          message: '请先绑定管理员身份'
        };
      }
    
      scorerRaw = adminRes.data[0];
    } else {
      const userRes = await db.collection('user_info')
        .where({ openid })
        .limit(1)
        .get();
    
      if (!userRes.data.length) {
        return {
          status: 'need_bind',
          message: '请先绑定用户身份'
        };
      }
    
      const binding = userRes.data[0];
      const hrId = safeString(binding.hrId || binding.hr_id);
    
      if (!hrId) {
        return {
          status: 'need_bind',
          message: '绑定记录缺少人事ID，请重新绑定'
        };
      }
    
      const hrRes = await db.collection('hr_info')
        .doc(hrId)
        .get()
        .catch(() => ({ data: null }));
    
      if (!hrRes.data) {
        return {
          status: 'need_bind',
          message: '绑定的人事信息不存在，请重新绑定'
        };
      }
    
      scorerRaw = hrRes.data;
    }
    
    const scorer = normalizePerson(scorerRaw, orgLookups);

  if (role === 'admin') {
    return {
      status: 'success',
      scorer,
      targets: []
    };
  }

  if (!scorer.departmentId || !scorer.identityId) {
    return {
      status: 'invalid_scorer',
      message: '当前用户缺少评分规则所需的人事信息。'
    };
  }

  const currentActivity = await fetchCurrentActivity();
  if (!currentActivity) {
    return {
      status: 'success',
      scorer,
      rule: null,
      currentActivity: null,
      targets: []
    };
  }

  const ruleRes = await db.collection('rate_target_rules')
    .where({
      activityId: currentActivity._id,
      scorerDepartmentId: scorer.departmentId,
      scorerIdentityId: scorer.identityId,
      isActive: true
    })
    .limit(1)
    .get();

  if (!ruleRes.data.length) {
    return {
      status: 'missing_rule',
      message: '当前评分人类别还没有配置被评分人规则。'
    };
  }

  const rule = ruleRes.data[0];
  const scoredTargetIdSet = await getScoredTargetIdSetByScorer(
    scorer,
    openid,
    currentActivity ? currentActivity._id : ''
  );
  const targetMap = new Map();

  for (const rawClause of rule.clauses || []) {
    const clause = normalizeClause(rawClause);
    if ((clause.scopeType === 'same_work_group_identity' || clause.scopeType === 'same_work_group_all') && !scorer.workGroupId) {
      continue;
    }

    const res = await fetchClauseTargets(scorer, clause);
    (res.data || []).forEach((item) => {
      if (!targetMap.has(item._id)) {
        const person = normalizePerson(item, orgLookups);
        const isScored = scoredTargetIdSet.has(item._id);
        targetMap.set(item._id, {
          ...person,
          isScored,
          scoreStatus: isScored ? 'scored' : 'pending',
          scoreStatusText: isScored ? '已评分' : '待评分'
        });
      }
    });
  }

  const targets = Array.from(targetMap.values()).sort((a, b) => {
    if (a.isScored !== b.isScored) {
      return a.isScored ? 1 : -1;
    }
    if (a.identity !== b.identity) {
      return a.identity.localeCompare(b.identity, 'zh-CN');
    }
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return {
    status: 'success',
    scorer,
    rule,
    currentActivity: currentActivity ? {
      id: currentActivity._id,
      name: currentActivity.name || ''
    } : null,
    targets
  };
};
