const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const FIELD_NAME = '姓名';
const FIELD_STUDENT_ID = '学号';
const FIELD_DEPARTMENT = '所属部门';
const FIELD_IDENTITY = '身份';
const FIELD_WORK_GROUP = '工作分工（职能组）';
const DEFAULT_WORK_GROUP = '未分组';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeMember(record = {}) {
  return {
    id: safeString(record._id),
    name: safeString(record.name || record[FIELD_NAME]),
    studentId: safeString(record.studentId || record[FIELD_STUDENT_ID]),
    department: safeString(record.department || record[FIELD_DEPARTMENT]),
    identity: safeString(record.identity || record[FIELD_IDENTITY]),
    workGroup: safeString(record.workGroup || record[FIELD_WORK_GROUP]) || DEFAULT_WORK_GROUP
  };
}

function normalizeRuleClause(rawClause = {}) {
  return {
    scopeType: safeString(rawClause.scopeType),
    targetIdentity: safeString(rawClause.targetIdentity),
    templateConfigs: Array.isArray(rawClause.templateConfigs)
      ? rawClause.templateConfigs.filter((item) => safeString(item.templateId))
      : []
  };
}

function getMemberRuleKey(member = {}) {
  return `${safeString(member.department)}::${safeString(member.identity)}`;
}

function getScorerUniqueKey(memberOrRecord = {}) {
  return safeString(memberOrRecord.scorerStudentId || memberOrRecord.studentId)
    || safeString(memberOrRecord.scorerId || memberOrRecord.id);
}

function matchesClauseTarget(target, scorer, clause) {
  if (clause.scopeType === 'same_department_identity') {
    return target.department === scorer.department && target.identity === clause.targetIdentity;
  }
  if (clause.scopeType === 'same_department_all') {
    return target.department === scorer.department;
  }
  if (clause.scopeType === 'same_work_group_identity') {
    return target.department === scorer.department
      && target.workGroup === scorer.workGroup
      && target.identity === clause.targetIdentity;
  }
  if (clause.scopeType === 'same_work_group_all') {
    return target.department === scorer.department && target.workGroup === scorer.workGroup;
  }
  if (clause.scopeType === 'identity_only') {
    return target.identity === clause.targetIdentity;
  }
  if (clause.scopeType === 'all_people') {
    return true;
  }
  return false;
}

function buildTaskRows(members, rules, records) {
  const membersByRuleKey = new Map();
  members.forEach((member) => {
    const key = getMemberRuleKey(member);
    if (!membersByRuleKey.has(key)) {
      membersByRuleKey.set(key, []);
    }
    membersByRuleKey.get(key).push(member);
  });

  const scorerMap = new Map();
  const expectedTaskMap = new Map();

  rules.forEach((rule) => {
    const scorers = membersByRuleKey.get(rule.scorerKey) || [];
    rule.clauses.forEach((clause) => {
      if (!clause.templateConfigs.length) {
        return;
      }
      scorers.forEach((scorer) => {
        const scorerKey = getScorerUniqueKey(scorer);
        if (!scorerKey) {
          return;
        }
        if (!scorerMap.has(scorerKey)) {
          scorerMap.set(scorerKey, {
            scorerKey,
            scorerId: scorer.id,
            scorerName: scorer.name,
            scorerStudentId: scorer.studentId,
            department: scorer.department,
            identity: scorer.identity,
            workGroup: scorer.workGroup || DEFAULT_WORK_GROUP,
            expectedTargets: new Map(),
            submittedTargetIds: new Set()
          });
        }
        const scorerRow = scorerMap.get(scorerKey);

        members.forEach((target) => {
          if (!matchesClauseTarget(target, scorer, clause)) {
            return;
          }
          const taskKey = `${scorerKey}::${target.id}`;
          expectedTaskMap.set(taskKey, {
            scorerKey,
            targetId: target.id
          });
          if (!scorerRow.expectedTargets.has(target.id)) {
            scorerRow.expectedTargets.set(target.id, {
              targetId: target.id,
              targetName: target.name,
              targetStudentId: target.studentId,
              targetDepartment: target.department,
              targetIdentity: target.identity,
              targetWorkGroup: target.workGroup || DEFAULT_WORK_GROUP
            });
          }
        });
      });
    });
  });

  records.forEach((record) => {
    const scorerKey = getScorerUniqueKey(record);
    const targetId = safeString(record.targetId);
    if (!scorerKey || !targetId) {
      return;
    }
    const scorerRow = scorerMap.get(scorerKey);
    if (!scorerRow || !scorerRow.expectedTargets.has(targetId)) {
      return;
    }
    scorerRow.submittedTargetIds.add(targetId);
  });

  return Array.from(scorerMap.values())
    .map((item) => {
      const pendingList = Array.from(item.expectedTargets.values())
        .filter((target) => !item.submittedTargetIds.has(target.targetId))
        .sort((a, b) => String(a.targetName).localeCompare(String(b.targetName), 'zh-CN'));
      const expectedCount = item.expectedTargets.size;
      const submittedCount = item.submittedTargetIds.size;
      const pendingCount = Math.max(expectedCount - submittedCount, 0);
      return {
        scorerKey: item.scorerKey,
        scorerId: item.scorerId,
        scorerName: item.scorerName,
        scorerStudentId: item.scorerStudentId,
        department: item.department,
        identity: item.identity,
        workGroup: item.workGroup || DEFAULT_WORK_GROUP,
        expectedCount,
        submittedCount,
        pendingCount,
        completionRate: expectedCount
          ? Number(((submittedCount / expectedCount) * 100).toFixed(2))
          : 100,
        pendingList
      };
    })
    .filter((item) => item.pendingCount > 0)
    .sort((a, b) => {
      if (a.completionRate !== b.completionRate) {
        return a.completionRate - b.completionRate;
      }
      if (a.pendingCount !== b.pendingCount) {
        return b.pendingCount - a.pendingCount;
      }
      return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN');
    });
}

function applyFilters(rows, filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);
  const keyword = safeString(filters.keyword).toLowerCase();
  const isAll = (value) => !value || value === '全部';

  return rows.filter((row) => {
    if (!isAll(department) && safeString(row.department) !== department) {
      return false;
    }
    if (!isAll(identity) && safeString(row.identity) !== identity) {
      return false;
    }
    if (!isAll(workGroup) && safeString(row.workGroup || DEFAULT_WORK_GROUP) !== workGroup) {
      return false;
    }
    if (!keyword) {
      return true;
    }
    const searchText = [
      row.scorerName,
      row.scorerStudentId,
      row.department,
      row.identity,
      row.workGroup
    ].join(' ').toLowerCase();
    return searchText.includes(keyword);
  });
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const activityId = safeString(event.activityId);
  const filters = event.filters || {};

  if (!activityId) {
    return {
      status: 'invalid_params',
      message: '请先选择评分活动'
    };
  }

  const admin = await ensureAdmin(openid);
  if (!admin) {
    return {
      status: 'forbidden',
      message: '没有管理权限'
    };
  }

  const [activityRes, hrRes, ruleRes, recordRes] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    db.collection('hr_info').limit(1000).get(),
    db.collection('rate_target_rules').where({ activityId }).limit(1000).get(),
    db.collection('score_records').where({ activityId }).limit(1000).get()
  ]);

  if (!activityRes.data) {
    return {
      status: 'activity_not_found',
      message: '未找到对应的评分活动'
    };
  }

  const members = (hrRes.data || []).map((item) => normalizeMember(item));
  const rules = (ruleRes.data || []).map((item) => ({
    _id: item._id,
    scorerKey: safeString(item.scorerKey),
    clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause)) : []
  }));
  const records = recordRes.data || [];
  const allRows = buildTaskRows(members, rules, records);
  const filteredRows = applyFilters(allRows, filters);

  return {
    status: 'success',
    activityName: safeString(activityRes.data.name),
    stats: {
      totalPendingScorers: filteredRows.length
    },
    filterOptions: {
      departments: Array.from(new Set(allRows.map((item) => item.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      identities: Array.from(new Set(allRows.map((item) => item.identity).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
      workGroups: Array.from(new Set(allRows.map((item) => item.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    },
    scorers: filteredRows
  };
};
