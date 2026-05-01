const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PAGE_SIZE = 100;
const MAX_PARALLEL_PAGES = 20;

const DEFAULT_WORK_GROUP = '';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function getAllRecords(query) {
  const countRes = await query.count().catch(() => ({ total: 0 }));
  const total = countRes.total || 0;
  if (total === 0) return [];

  const pageSize = 100;
  const totalPages = Math.min(Math.ceil(total / pageSize), MAX_PARALLEL_PAGES);
  const promises = [];
  for (let i = 0; i < totalPages; i++) {
    promises.push(
      query.skip(i * pageSize).limit(pageSize).get().catch((error) => {
        const message = safeString(error && (error.message || error.errMsg));
        if (message.includes('DATABASE_COLLECTION_NOT_EXIST') || message.includes('collection not exists')) {
          return { data: [] };
        }
        throw error;
      })
    );
  }
  const results = await Promise.all(promises);
  return results.flatMap((res) => res.data || []);
}

function buildOrgMap(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const id = safeString(row && row._id);
    if (!id) return;
    map.set(id, {
      id,
      name: safeString(row.name)
    });
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
    departmentsById: buildOrgMap(departments),
    identitiesById: buildOrgMap(identities),
    workGroupsById: buildOrgMap(workGroups)
  };
}

function getLookupName(map, id) {
  const row = map && map.get(safeString(id));
  return row ? safeString(row.name) : '';
}

function makeOrgRuleKey(departmentId, identityId) {
  const depId = safeString(departmentId);
  const idId = safeString(identityId);
  return depId && idId ? depId + '::' + idId : '';
}

function normalizeMember(record = {}, orgLookups = {}) {
  const departmentId = safeString(record.departmentId);
  const identityId = safeString(record.identityId);
  const workGroupId = safeString(record.workGroupId);
  const department = getLookupName(orgLookups.departmentsById, departmentId);
  const identity = getLookupName(orgLookups.identitiesById, identityId);
  const workGroup = getLookupName(orgLookups.workGroupsById, workGroupId) || DEFAULT_WORK_GROUP;

  return {
    id: safeString(record._id),
    name: safeString(record.name),
    studentId: safeString(record.studentId),
    departmentId,
    department,
    identityId,
    identity,
    workGroupId,
    workGroup
  };
}

function normalizeRuleClause(rawClause = {}, orgLookups = {}) {
  const targetIdentityId = safeString(rawClause.targetIdentityId);
  return {
    scopeType: safeString(rawClause.scopeType),
    targetIdentityId,
    targetIdentity: getLookupName(orgLookups.identitiesById, targetIdentityId),
    templateConfigs: Array.isArray(rawClause.templateConfigs)
      ? rawClause.templateConfigs.filter((item) => safeString(item.templateId))
      : []
  };
}

function getMemberRuleKey(member = {}) {
  return makeOrgRuleKey(member.departmentId, member.identityId);
}

function getScorerUniqueKey(memberOrRecord = {}) {
  return safeString(memberOrRecord.scorerId || memberOrRecord.id)
    || safeString(memberOrRecord.studentId);
}

function sameDepartment(left = {}, right = {}) {
  return safeString(left.departmentId) && safeString(left.departmentId) === safeString(right.departmentId);
}

function sameWorkGroup(left = {}, right = {}) {
  return safeString(left.workGroupId) && safeString(left.workGroupId) === safeString(right.workGroupId);
}

function matchesTargetIdentity(target = {}, clause = {}) {
  return safeString(target.identityId) && safeString(target.identityId) === safeString(clause.targetIdentityId);
}

function matchesClauseTarget(target, scorer, clause) {
  if (clause.scopeType === 'same_department_identity') return sameDepartment(target, scorer) && matchesTargetIdentity(target, clause);
  if (clause.scopeType === 'same_department_all') return sameDepartment(target, scorer);
  if (clause.scopeType === 'same_work_group_identity') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer) && matchesTargetIdentity(target, clause);
  if (clause.scopeType === 'same_work_group_all') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer);
  if (clause.scopeType === 'identity_only') return matchesTargetIdentity(target, clause);
  if (clause.scopeType === 'all_people') return true;
  return false;
}

function buildTaskRows(members, rules, records, options = {}) {
  const { includePendingList = false, scorerKey: requestedScorerKey } = options;
  const membersByRuleKey = new Map();

  members.forEach((member) => {
    const key = getMemberRuleKey(member);
    if (!key) return;
    if (!membersByRuleKey.has(key)) membersByRuleKey.set(key, []);
    membersByRuleKey.get(key).push(member);
  });

  const scorerMap = new Map();

  rules.forEach((rule) => {
    const scorers = membersByRuleKey.get(rule.scorerKey) || [];

    (rule.clauses || []).forEach((clause) => {
      if (!clause.templateConfigs || !clause.templateConfigs.length) return;

      scorers.forEach((scorer) => {
        const scorerKey = getScorerUniqueKey(scorer);
        if (!scorerKey) return;

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
          if (!matchesClauseTarget(target, scorer, clause)) return;

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
    if (!scorerKey || !targetId) return;

    const scorerRow = scorerMap.get(scorerKey);
    if (!scorerRow || !scorerRow.expectedTargets.has(targetId)) return;

    scorerRow.submittedTargetIds.add(targetId);
  });

  return Array.from(scorerMap.values())
    .filter((item) => {
      if (requestedScorerKey) return item.scorerKey === requestedScorerKey;
      const expectedCount = item.expectedTargets.size;
      const submittedCount = Array.from(item.submittedTargetIds)
        .filter((targetId) => item.expectedTargets.has(targetId))
        .length;
      return expectedCount - submittedCount > 0;
    })
    .map((item) => {
      const expectedCount = item.expectedTargets.size;
      const submittedCount = Array.from(item.submittedTargetIds)
        .filter((targetId) => item.expectedTargets.has(targetId))
        .length;
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
        completionRate: expectedCount ? Number(((submittedCount / expectedCount) * 100).toFixed(2)) : 100,
        pendingList: includePendingList ? Array.from(item.expectedTargets.values())
          .filter((target) => !item.submittedTargetIds.has(target.targetId))
          .sort((a, b) => String(a.targetName).localeCompare(String(b.targetName), 'zh-CN')) : undefined
      };
    })
    .sort((a, b) => {
      if (a.completionRate !== b.completionRate) return a.completionRate - b.completionRate;
      if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount;
      return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN');
    });
}

function applyFilters(rows, filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);
  const keyword = safeString(filters.keyword).toLowerCase();
  const isAll = (value) => !value
    || value === '全部'
    || value === '全部部门'
    || value === '全部身份'
    || value === '全部工作分工'
    || value === '全部工作分工（职能组）'
    || value === '鍏ㄩ儴';

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
const RESPONSE_SAFE_LIMIT = 850 * 1024;

function estimateBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function sliceRowsBySize(rows, offset, basePayload) {
  const start = Math.max(0, Math.floor(toNumber(offset, 0)));
  const selected = [];

  for (let i = start; i < rows.length; i += 1) {
    selected.push(rows[i]);

    const testPayload = {
      ...basePayload,
      scorers: selected
    };

    if (estimateBytes(testPayload) > RESPONSE_SAFE_LIMIT) {
      selected.pop();
      return {
        rows: selected,
        nextOffset: i,
        hasMore: true,
        total: rows.length
      };
    }
  }

  return {
    rows: selected,
    nextOffset: rows.length,
    hasMore: false,
    total: rows.length
  };
}


function buildTaskResponseFromPayload(payload, filters, offset) {
  const filteredRows = applyFilters(payload.scorers || [], filters);
  const basePayload = {
    status: 'success',
    activityName: payload.activityName || '',
    stats: {
      totalPendingScorers: filteredRows.length
    },
    filterOptions: payload.filterOptions || {},
    scorers: [],
    pagination: {
      offset,
      nextOffset: offset,
      total: filteredRows.length,
      hasMore: false,
      returnedCount: 0
    }
  };

  const pageResult = sliceRowsBySize(filteredRows, offset, basePayload);
  basePayload.scorers = pageResult.rows;
  basePayload.pagination = {
    offset,
    nextOffset: pageResult.nextOffset,
    total: filteredRows.length,
    hasMore: pageResult.hasMore,
    returnedCount: pageResult.rows.length
  };

  return basePayload;
}

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const activityId = safeString(event.activityId);
    const filters = event.filters || {};
    const offset = Math.max(0, Math.floor(toNumber(event.offset, 0)));
    const scorerKey = safeString(event.scorerKey);

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

    const [activityRes, membersRaw, rulesRaw, records, orgLookups] = await Promise.all([
      db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
      getAllRecords(db.collection('hr_info')),
      getAllRecords(db.collection('rate_target_rules').where({ activityId })),
      getAllRecords(db.collection('score_records').where({ activityId })),
      fetchOrgLookups()
    ]);

    if (!activityRes.data) {
      return {
        status: 'activity_not_found',
        message: '未找到对应的评分活动'
      };
    }

    const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
    const rules = rulesRaw.map((item) => {
      const scorerDepartmentId = safeString(item.scorerDepartmentId);
      const scorerIdentityId = safeString(item.scorerIdentityId);
      const scorerDepartment = getLookupName(orgLookups.departmentsById, scorerDepartmentId);
      const scorerIdentity = getLookupName(orgLookups.identitiesById, scorerIdentityId);
      return {
        _id: item._id,
        scorerKey: makeOrgRuleKey(scorerDepartmentId, scorerIdentityId),
        clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause, orgLookups)) : []
      };
    });

    if (scorerKey) {
      const scorerRows = buildTaskRows(members, rules, records, { includePendingList: true, scorerKey });
      const scorer = scorerRows[0] || null;
      return {
        status: 'success',
        scorer: scorer ? {
          scorerKey: scorer.scorerKey,
          scorerName: scorer.scorerName,
          pendingList: scorer.pendingList || []
        } : null
      };
    }

    const allRows = buildTaskRows(members, rules, records, { includePendingList: false });
    const fullPayload = {
      activityName: safeString(activityRes.data.name),
      stats: {
        totalPendingScorers: allRows.length
      },
      filterOptions: {
        departments: Array.from(new Set(allRows.map((item) => item.department).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
        identities: Array.from(new Set(allRows.map((item) => item.identity).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
        workGroups: Array.from(new Set(allRows.map((item) => item.workGroup || DEFAULT_WORK_GROUP).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
      },
      scorers: allRows
    };
    return buildTaskResponseFromPayload(fullPayload, filters, offset);
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '获取未完成评分任务失败'
    };
  }
};
