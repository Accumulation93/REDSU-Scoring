const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const PAGE_SIZE = 100;
const TASK_CACHE_META = 'scorer_task_cache_meta';
const TASK_CACHE_CHUNKS = 'scorer_task_cache_chunks';
const CACHE_CHUNK_SAFE_LIMIT = 650 * 1024;

const FIELD_NAME = '姓名';
const FIELD_STUDENT_ID = '学号';
const FIELD_DEPARTMENT = '所属部门';
const FIELD_IDENTITY = '身份';
const FIELD_WORK_GROUP = '工作分工（职能组）';
const DEFAULT_WORK_GROUP = '未分组';

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function getAllRecords(query) {
  const list = [];
  let skip = 0;

  while (true) {
    const res = await query.skip(skip).limit(PAGE_SIZE).get().catch((error) => {
      const message = safeString(error && (error.message || error.errMsg));
      if (message.includes('DATABASE_COLLECTION_NOT_EXIST') || message.includes('collection not exists')) {
        return { data: [] };
      }
      throw error;
    });
    const batch = res.data || [];
    list.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
    skip += batch.length;
  }

  return list;
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

function buildRowChunks(rows) {
  const chunks = [];
  let current = [];

  rows.forEach((row) => {
    current.push(row);
    if (estimateBytes({ rows: current }) > CACHE_CHUNK_SAFE_LIMIT && current.length > 1) {
      const overflow = current.pop();
      chunks.push(current);
      current = [overflow];
    }
  });

  if (current.length) {
    chunks.push(current);
  }

  return chunks.length ? chunks : [[]];
}

function buildChunkMeta(chunks) {
  let rowStart = 0;
  return chunks.map((rows, chunkIndex) => {
    const rowCount = rows.length;
    const meta = {
      chunkIndex,
      rowStart,
      rowCount
    };
    rowStart += rowCount;
    return meta;
  });
}

function isUnfiltered(filters = {}) {
  const isAll = (value) => !value
    || value === '全部'
    || value === '全部部门'
    || value === '全部身份'
    || value === '全部工作分工'
    || value === '全部工作分工（职能组）';
  return isAll(safeString(filters.department))
    && isAll(safeString(filters.identity))
    && isAll(safeString(filters.workGroup))
    && !safeString(filters.keyword);
}

async function removeQueryRecords(collectionName, where) {
  while (true) {
    const res = await db.collection(collectionName).where(where).limit(100).get().catch((error) => {
      const message = safeString(error && (error.message || error.errMsg));
      if (message.includes('DATABASE_COLLECTION_NOT_EXIST') || message.includes('collection not exists')) {
        return { data: [] };
      }
      throw error;
    });
    const rows = res.data || [];
    if (!rows.length) {
      break;
    }
    await Promise.all(rows.map((item) => db.collection(collectionName).doc(item._id).remove()));
    if (rows.length < 100) {
      break;
    }
  }
}

async function upsertByActivity(collectionName, activityId, data) {
  const res = await db.collection(collectionName).where({ activityId }).limit(1).get().catch((error) => {
    const message = safeString(error && (error.message || error.errMsg));
    if (message.includes('DATABASE_COLLECTION_NOT_EXIST') || message.includes('collection not exists')) {
      return { data: [] };
    }
    throw error;
  });
  if (res.data && res.data.length) {
    await db.collection(collectionName).doc(res.data[0]._id).update({ data });
    return res.data[0]._id;
  }
  const addRes = await db.collection(collectionName).add({
    data: {
      activityId,
      ...data
    }
  });
  return addRes._id;
}

async function writeTaskCache(activityId, payload) {
  await removeQueryRecords(TASK_CACHE_CHUNKS, { activityId });
  const chunks = buildRowChunks(payload.scorers || []);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    await db.collection(TASK_CACHE_CHUNKS).add({
      data: {
        activityId,
        chunkIndex,
        rows: chunks[chunkIndex],
        updatedAt: db.serverDate()
      }
    });
  }

  await upsertByActivity(TASK_CACHE_META, activityId, {
    activityName: payload.activityName,
    stats: payload.stats,
    filterOptions: payload.filterOptions,
    chunkMap: buildChunkMeta(chunks),
    total: (payload.scorers || []).length,
    isInvalid: false,
    updatedAt: db.serverDate()
  });
}

async function readTaskCache(activityId, offset, filters) {
  const metaRes = await db.collection(TASK_CACHE_META)
    .where({ activityId, isInvalid: false })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));

  if (!metaRes.data || !metaRes.data.length) {
    return null;
  }

  const meta = metaRes.data[0];
  const chunkMetaList = Array.isArray(meta.chunkMap) ? meta.chunkMap : [];
  let chunks = [];
  let cacheRowStart = 0;
  const cacheTotal = toNumber(meta.total, 0);

  if (isUnfiltered(filters) && chunkMetaList.length) {
    const targetChunkMeta = chunkMetaList.find((item) => (
      offset >= toNumber(item.rowStart, 0)
      && offset < toNumber(item.rowStart, 0) + toNumber(item.rowCount, 0)
    )) || chunkMetaList[chunkMetaList.length - 1];
    cacheRowStart = toNumber(targetChunkMeta.rowStart, 0);
    const chunkRes = await db.collection(TASK_CACHE_CHUNKS)
      .where({ activityId, chunkIndex: toNumber(targetChunkMeta.chunkIndex, 0) })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }));
    chunks = chunkRes.data || [];
  } else {
    chunks = await getAllRecords(db.collection(TASK_CACHE_CHUNKS).where({ activityId }));
  }

  if (!chunks.length) {
    return null;
  }
  chunks.sort((a, b) => toNumber(a.chunkIndex, 0) - toNumber(b.chunkIndex, 0));

  return {
    activityName: meta.activityName || '',
    stats: meta.stats || {},
    filterOptions: meta.filterOptions || {},
    _cacheRowStart: cacheRowStart,
    _cacheTotal: cacheTotal,
    _cachePartial: isUnfiltered(filters) && chunkMetaList.length,
    scorers: chunks.flatMap((item) => Array.isArray(item.rows) ? item.rows : [])
  };
}

function buildTaskResponseFromPayload(payload, filters, offset) {
  const filteredRows = applyFilters(payload.scorers || [], filters);
  const cachePartial = payload._cachePartial === true;
  const cacheRowStart = cachePartial ? toNumber(payload._cacheRowStart, 0) : 0;
  const cacheTotal = cachePartial ? toNumber(payload._cacheTotal, filteredRows.length) : filteredRows.length;
  const sliceOffset = cachePartial ? Math.max(0, offset - cacheRowStart) : offset;
  const basePayload = {
    status: 'success',
    activityName: payload.activityName || '',
    stats: {
      totalPendingScorers: cacheTotal
    },
    filterOptions: payload.filterOptions || {},
    scorers: [],
    pagination: {
      offset,
      nextOffset: offset,
      total: cacheTotal,
      hasMore: false,
      returnedCount: 0
    }
  };

  const pageResult = sliceRowsBySize(filteredRows, sliceOffset, basePayload);
  basePayload.scorers = pageResult.rows;
  basePayload.pagination = {
    offset,
    nextOffset: cachePartial ? cacheRowStart + pageResult.nextOffset : pageResult.nextOffset,
    total: cacheTotal,
    hasMore: cachePartial ? (cacheRowStart + pageResult.nextOffset < cacheTotal) : pageResult.hasMore,
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

    const cachedPayload = await readTaskCache(activityId, offset, filters);
    if (cachedPayload) {
      return buildTaskResponseFromPayload(cachedPayload, filters, offset);
    }

    const [activityRes, membersRaw, rulesRaw, records] = await Promise.all([
      db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
      getAllRecords(db.collection('hr_info')),
      getAllRecords(db.collection('rate_target_rules').where({ activityId })),
      getAllRecords(db.collection('score_records').where({ activityId }))
    ]);

    if (!activityRes.data) {
      return {
        status: 'activity_not_found',
        message: '未找到对应的评分活动'
      };
    }

    const members = membersRaw.map((item) => normalizeMember(item));
    const rules = rulesRaw.map((item) => ({
      _id: item._id,
      scorerKey: safeString(item.scorerKey),
      clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause)) : []
    }));
    const allRows = buildTaskRows(members, rules, records);
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

    await writeTaskCache(activityId, fullPayload).catch(() => null);
    return buildTaskResponseFromPayload(fullPayload, filters, offset);
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '获取未完成评分任务失败'
    };
  }
};
