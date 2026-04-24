const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const PROFILE_COLLECTION_MAP = {
  user: 'user_info',
  admin: 'admin_info'
};

const SOURCE_COLLECTION_MAP = {
  user: 'hr_info',
  admin: 'admin_info'
};

function normalizePerson(record) {
  const name = record.name || record['姓名'] || '';
  const studentId = record.studentId || record['学号'] || '';
  const identity = record.identity || record['身份'] || '';
  const department = record.department || record['所属部门'] || '';
  const workGroup = record.workGroup || record['工作分工（职能组）'] || '';
  const adminLevel = record.adminLevel || '';

  return {
    id: record._id || `${name}-${studentId}-${identity || adminLevel}`,
    name,
    studentId,
    identity,
    department,
    workGroup,
    adminLevel
  };
}

function getRuleKey(person) {
  return `${person.department}::${person.identity}`;
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

async function enrichScorer(profileCollection, sourceCollection, profileDoc) {
  const profile = normalizePerson(profileDoc);

  if (profileCollection === 'admin_info') {
    return {
      ...profile,
      identity: profile.adminLevel === 'super_admin' ? '超级管理员' : '普通管理员'
    };
  }

  if (profile.department && profile.identity) {
    return profile;
  }

  let sourceQuery = null;

  if (profile.studentId) {
    sourceQuery = db.collection(sourceCollection).where({
      学号: profile.studentId
    });
  } else if (profile.name) {
    sourceQuery = db.collection(sourceCollection).where({
      姓名: profile.name
    });
  }

  if (!sourceQuery) {
    return profile;
  }

  const sourceRes = await sourceQuery.limit(1).get();

  if (!sourceRes.data.length) {
    return profile;
  }

  const sourceItem = sourceRes.data[0];
  const enriched = {
    ...profile,
    identity: sourceItem['身份'] || profile.identity,
    department: sourceItem['所属部门'] || profile.department,
    workGroup: sourceItem['工作分工（职能组）'] || profile.workGroup
  };

  if (profileDoc._id) {
    await db.collection(profileCollection)
      .doc(profileDoc._id)
      .update({
        data: {
          identity: enriched.identity,
          department: enriched.department,
          workGroup: enriched.workGroup
        }
      });
  }

  return enriched;
}

async function fetchClauseTargets(scorer, clause) {
  const where = {};

  if (clause.scopeType === 'same_department_identity') {
    where['所属部门'] = scorer.department;
    where['身份'] = clause.targetIdentity;
  } else if (clause.scopeType === 'same_department_all') {
    where['所属部门'] = scorer.department;
  } else if (clause.scopeType === 'same_work_group_identity') {
    where['所属部门'] = scorer.department;
    where['工作分工（职能组）'] = scorer.workGroup;
    where['身份'] = clause.targetIdentity;
  } else if (clause.scopeType === 'same_work_group_all') {
    where['所属部门'] = scorer.department;
    where['工作分工（职能组）'] = scorer.workGroup;
  } else if (clause.scopeType === 'identity_only') {
    where['身份'] = clause.targetIdentity;
  } else if (clause.scopeType === 'all_people') {
    return db.collection('hr_info').limit(1000).get();
  } else {
    return { data: [] };
  }

  return db.collection('hr_info')
    .where(where)
    .limit(1000)
    .get();
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

  if (scorer.studentId) {
    queries.push(activityId ? { scorerStudentId: scorer.studentId, activityId } : { scorerStudentId: scorer.studentId });
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
  const sourceCollection = SOURCE_COLLECTION_MAP[role] || SOURCE_COLLECTION_MAP.user;

  const where = role === 'admin'
    ? { openid, bindStatus: 'active' }
    : { openid };

  const scorerRes = await db.collection(profileCollection)
    .where(where)
    .limit(1)
    .get();

  if (!scorerRes.data.length) {
    return {
      status: 'user_not_found',
      message: '未找到当前身份信息，请重新登录。'
    };
  }

  const scorer = await enrichScorer(profileCollection, sourceCollection, scorerRes.data[0]);

  if (role === 'admin') {
    return {
      status: 'success',
      scorer,
      targets: []
    };
  }

  if (!scorer.department || !scorer.identity) {
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
      scorerKey: getRuleKey(scorer),
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

  for (const clause of rule.clauses || []) {
    if ((clause.scopeType === 'same_work_group_identity' || clause.scopeType === 'same_work_group_all') && !scorer.workGroup) {
      continue;
    }

    const res = await fetchClauseTargets(scorer, clause);
    (res.data || []).forEach((item) => {
      if (!targetMap.has(item._id)) {
        const person = normalizePerson(item);
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
