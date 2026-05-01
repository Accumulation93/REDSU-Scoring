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
    map.set(id, { id, name: safeString(row.name) });
  });
  return map;
}

async function fetchOrgLookups() {
  const [departments, identities, workGroups, templates] = await Promise.all([
    getAllRecords(db.collection('departments')),
    getAllRecords(db.collection('identities')),
    getAllRecords(db.collection('work_groups')),
    getAllRecords(db.collection('score_question_templates'))
  ]);
  return {
    departmentsById: buildOrgMap(departments),
    identitiesById: buildOrgMap(identities),
    workGroupsById: buildOrgMap(workGroups),
    templatesById: new Map(templates.map((item) => [safeString(item._id), { name: safeString(item.name), questionCount: Array.isArray(item.questions) ? item.questions.length : 0 }]))
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
  const templateConfigs = Array.isArray(rawClause.templateConfigs)
    ? rawClause.templateConfigs
    : [];
  return {
    scopeType: safeString(rawClause.scopeType),
    targetIdentityId,
    targetIdentity: getLookupName(orgLookups.identitiesById, targetIdentityId),
    templateConfigs: templateConfigs.filter((item) => safeString(item.templateId)).map((item) => { const templateId = safeString(item.templateId); const tpl = orgLookups.templatesById && orgLookups.templatesById.get(templateId); return { ...item, templateId, templateName: safeString(item.templateName) || safeString(tpl && tpl.name) }; })
  };
}

function getMemberRuleKey(member = {}) {
  return makeOrgRuleKey(member.departmentId, member.identityId);
}

function getScorerUniqueKey(memberOrRecord = {}) {
  return safeString(memberOrRecord.scorerId || memberOrRecord.id)
    || safeString(memberOrRecord.studentId);
}

function createScorerKeyResolver(members = []) {
  const aliasMap = new Map();
  members.forEach((member) => {
    const canonicalKey = getScorerUniqueKey(member);
    [
      member.id,
      member.studentId,
      member.scorerId
    ].forEach((value) => {
      const key = safeString(value);
      if (key) {
        aliasMap.set(key, canonicalKey);
      }
    });
  });
  return function resolveScorerKey(record = {}) {
    const rawKeys = [
      record.scorerId,
      record.id
    ].map((value) => safeString(value)).filter(Boolean);
    for (const key of rawKeys) {
      if (aliasMap.has(key)) {
        return aliasMap.get(key);
      }
    }
    for (const key of rawKeys) {
      return key;
    }
    return '';
  };
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
  const scopeType = safeString(clause.scopeType);
  if (scopeType === 'same_department_identity') return sameDepartment(target, scorer) && matchesTargetIdentity(target, clause);
  if (scopeType === 'same_department_all') return sameDepartment(target, scorer);
  if (scopeType === 'same_work_group_identity') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer) && matchesTargetIdentity(target, clause);
  if (scopeType === 'same_work_group_all') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer);
  if (scopeType === 'identity_only') return matchesTargetIdentity(target, clause);
  if (scopeType === 'all_people') return true;
  return false;
}

function applyFiltersToRows(payload, filters = {}) {
  const department = safeString(filters.department);
  const identity = safeString(filters.identity);
  const workGroup = safeString(filters.workGroup);
  const isAll = (value) => !value
    || value === '全部'
    || value === '全部部门'
    || value === '全部身份'
    || value === '全部工作分工'
    || value === '全部工作分工（职能组）'
    || value === '鍏ㄩ儴';
  const matches = (row) => {
    if (!isAll(department) && safeString(row.department || row.scorerDepartment || row.targetDepartment) !== department) {
      return false;
    }
    if (!isAll(identity) && safeString(row.identity || row.scorerIdentity || row.targetIdentity) !== identity) {
      return false;
    }
    if (!isAll(workGroup) && safeString(row.workGroup || row.scorerWorkGroup || row.targetWorkGroup || DEFAULT_WORK_GROUP) !== workGroup) {
      return false;
    }
    return true;
  };

  return {
    ...payload,
    completionRows: (payload.completionRows || []).filter(matches),
    overviewRows: (payload.overviewRows || []).filter(matches),
    detailRows: (payload.detailRows || []).filter(matches)
  };
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

async function buildScorerCompletionPayload(activityId) {
  const [activityRes, membersRaw, rulesRaw, recordsRaw, orgLookups] = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(() => ({ data: null })),
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId })),
    getAllRecords(db.collection('score_records').where({ activityId })),
    fetchOrgLookups()
  ]);

  const activity = activityRes.data;
  if (!activity) {
    return {
      status: 'activity_not_found',
      message: '未找到对应的评分活动'
    };
  }

  const members = membersRaw.map((item) => normalizeMember(item, orgLookups));
  const resolveScorerKey = createScorerKeyResolver(members);

  const rules = rulesRaw.map((item) => {
    const scorerDepartmentId = safeString(item.scorerDepartmentId);
    const scorerIdentityId = safeString(item.scorerIdentityId);
    return {
      ...item,
      scorerDepartmentId,
      scorerIdentityId,
      clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause, orgLookups)) : []
    };
  });

  const membersByRuleKey = new Map();
  members.forEach((member) => {
    const key = getMemberRuleKey(member);
    if (!membersByRuleKey.has(key)) {
      membersByRuleKey.set(key, []);
    }
    membersByRuleKey.get(key).push(member);
  });

  const expectedTaskMap = new Map();
  const scorerTaskMap = new Map();

  rules.forEach((rule) => {
    const ruleKey = makeOrgRuleKey(rule.scorerDepartmentId, rule.scorerIdentityId);
    const scorers = membersByRuleKey.get(ruleKey) || [];
    rule.clauses.forEach((clause, clauseIndex) => {
      if (!clause.templateConfigs.length) {
        return;
      }
      scorers.forEach((scorer) => {
        members.forEach((target) => {
          if (!matchesClauseTarget(target, scorer, clause)) {
            return;
          }
          const scorerKey = getScorerUniqueKey(scorer);
          const taskKey = `${safeString(rule._id)}::${clauseIndex}::${scorerKey}::${target.id}`;
          expectedTaskMap.set(taskKey, {
            taskKey,
            ruleId: safeString(rule._id),
            scorerKey,
            scorerId: scorer.id,
            scorerName: scorer.name,
            scorerStudentId: scorer.studentId,
            department: scorer.department,
            identity: scorer.identity,
            workGroup: scorer.workGroup || DEFAULT_WORK_GROUP,
            targetId: target.id
          });
        });
      });
    });
  });

  expectedTaskMap.forEach((task) => {
    if (!scorerTaskMap.has(task.scorerKey)) {
      scorerTaskMap.set(task.scorerKey, {
        scorerKey: task.scorerKey,
        scorerId: task.scorerId,
        scorerName: task.scorerName,
        scorerStudentId: task.scorerStudentId,
        department: task.department,
        identity: task.identity,
        workGroup: task.workGroup,
        expectedTaskKeys: new Set(),
        submittedTaskKeys: new Set()
      });
    }
    scorerTaskMap.get(task.scorerKey).expectedTaskKeys.add(task.taskKey);
  });

  const pairRecordsMap = new Map();
  recordsRaw.forEach((record) => {
    const scorerKey = resolveScorerKey(record);
    const targetId = safeString(record.targetId);
    if (!scorerKey || !targetId) {
      return;
    }
    const pairKey = `${scorerKey}::${targetId}`;
    if (!pairRecordsMap.has(pairKey)) {
      pairRecordsMap.set(pairKey, []);
    }
    pairRecordsMap.get(pairKey).push(record);
  });

  expectedTaskMap.forEach((task) => {
    const taskRecords = pairRecordsMap.get(`${task.scorerKey}::${task.targetId}`) || [];
    const hasRecord = taskRecords.some((record) => safeString(record.ruleId) === task.ruleId);
    if (!hasRecord) {
      return;
    }
    const scorerStat = scorerTaskMap.get(task.scorerKey);
    if (scorerStat) {
      scorerStat.submittedTaskKeys.add(task.taskKey);
    }
  });

  const completionRows = Array.from(scorerTaskMap.values())
    .map((item) => ({
      scorerId: item.scorerId,
      scorerName: item.scorerName,
      scorerStudentId: item.scorerStudentId,
      department: item.department,
      identity: item.identity,
      workGroup: item.workGroup,
      expectedCount: item.expectedTaskKeys.size,
      submittedCount: item.submittedTaskKeys.size,
      pendingCount: Math.max(item.expectedTaskKeys.size - item.submittedTaskKeys.size, 0),
      completionRate: item.expectedTaskKeys.size
        ? Number(((item.submittedTaskKeys.size / item.expectedTaskKeys.size) * 100).toFixed(2))
        : 0
    }))
    .sort((a, b) => {
      if (a.pendingCount !== b.pendingCount) {
        return b.pendingCount - a.pendingCount;
      }
      return String(a.scorerName).localeCompare(String(b.scorerName), 'zh-CN');
    });

  return {
    status: 'success',
    activityName: safeString(activity.name),
    completionRows
  };
}

function escapeCsvCell(value) {
  const text = String(value == null ? '' : value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(headers, rows) {
  const lines = [headers.map((item) => escapeCsvCell(item.label)).join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((item) => escapeCsvCell(row[item.key])).join(','));
  });
  return `\ufeff${lines.join('\r\n')}`;
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildExcelXml(sheetName, headers, rows) {
  const headerXml = headers.map((item) => (
    `<Cell ss:StyleID="header"><Data ss:Type="String">${escapeXml(item.label)}</Data></Cell>`
  )).join('');
  const rowXml = rows.map((row) => {
    const cells = headers.map((item) => {
      const value = row[item.key];
      const isNumber = typeof value === 'number' && Number.isFinite(value);
      return `<Cell><Data ss:Type="${isNumber ? 'Number' : 'String'}">${escapeXml(value)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#DCEBFF" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${escapeXml(sheetName)}">
  <Table>
   <Row>${headerXml}</Row>
   ${rowXml}
  </Table>
 </Worksheet>
</Workbook>`;
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : (fallback || 0);
}

function roundScore(value) {
  return Number(toNumber(value, 0).toFixed(3));
}

function normalizeMemberFull(record = {}, orgLookups = {}) {
  const departmentId = safeString(record.departmentId);
  const identityId = safeString(record.identityId);
  const workGroupId = safeString(record.workGroupId);
  const department = getLookupName(orgLookups.departmentsById, departmentId);
  const identity = getLookupName(orgLookups.identitiesById, identityId);
  const workGroup = getLookupName(orgLookups.workGroupsById, workGroupId) || '';
  return {
    id: safeString(record._id),
    name: safeString(record.name),
    studentId: safeString(record.studentId),
    departmentId, department,
    identityId, identity,
    workGroupId, workGroup
  };
}

function makeOrgRuleKey(departmentId, identityId) {
  return safeString(departmentId) + '::' + safeString(identityId);
}

function getMemberRuleKey(member) {
  return makeOrgRuleKey(member.departmentId, member.identityId);
}

function sameDepartment(left, right) {
  return safeString(left.departmentId) && safeString(left.departmentId) === safeString(right.departmentId);
}

function sameWorkGroup(left, right) {
  return safeString(left.workGroupId) && safeString(left.workGroupId) === safeString(right.workGroupId);
}

function matchesTargetIdentity(target, clause) {
  return safeString(target.identityId) && safeString(target.identityId) === safeString(clause.targetIdentityId);
}

function matchesClauseTarget(target, scorer, clause) {
  const scopeType = safeString(clause.scopeType);
  if (scopeType === 'same_department_identity') return sameDepartment(target, scorer) && matchesTargetIdentity(target, clause);
  if (scopeType === 'same_department_all') return sameDepartment(target, scorer);
  if (scopeType === 'same_work_group_identity') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer) && matchesTargetIdentity(target, clause);
  if (scopeType === 'same_work_group_all') return sameDepartment(target, scorer) && sameWorkGroup(target, scorer);
  if (scopeType === 'identity_only') return matchesTargetIdentity(target, clause);
  if (scopeType === 'all_people') return true;
  return false;
}

function getScorerUniqueKey(memberOrRecord) {
  return safeString(memberOrRecord.scorerId || memberOrRecord.id) || safeString(memberOrRecord.studentId);
}

function normalizeRuleClauseFull(rawClause, orgLookups) {
  const targetIdentityId = safeString(rawClause.targetIdentityId);
  return {
    scopeType: safeString(rawClause.scopeType),
    targetIdentityId,
    targetIdentity: getLookupName(orgLookups.identitiesById, targetIdentityId),
    requireAllComplete: rawClause.requireAllComplete === true,
    templateConfigs: Array.isArray(rawClause.templateConfigs)
      ? rawClause.templateConfigs.filter(function (item) { return safeString(item.templateId); })
        .map(function (item) {
          var tpl = orgLookups.templatesById && orgLookups.templatesById.get(safeString(item.templateId));
          return {
            templateId: safeString(item.templateId),
            templateName: safeString(item.templateName) || safeString(tpl && tpl.name),
            weight: toNumber(item.weight, 0),
            sortOrder: toNumber(item.sortOrder, 0),
            questionCount: tpl ? (Array.isArray(tpl.questions) ? tpl.questions.length : 0) : 0,
            questions: tpl ? (Array.isArray(tpl.questions) ? tpl.questions : []) : []
          };
        })
        .sort(function (a, b) { return a.sortOrder - b.sortOrder; })
      : []
  };
}

function normalizeRules(rulesRaw, orgLookups) {
  return (rulesRaw || []).map(function (item) {
    return {
      _id: safeString(item._id),
      scorerDepartmentId: safeString(item.scorerDepartmentId),
      scorerIdentityId: safeString(item.scorerIdentityId),
      clauses: Array.isArray(item.clauses) ? item.clauses.map(function (c) { return normalizeRuleClauseFull(c, orgLookups); }) : []
    };
  });
}

async function buildOverviewExportPayload(activityId) {
  var results = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(function () { return { data: null }; }),
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId: activityId })),
    getAllRecords(db.collection('score_records').where({ activityId: activityId })),
    fetchOrgLookups()
  ]);

  var activity = results[0].data;
  var membersRaw = results[1];
  var rulesRaw = results[2];
  var recordsRaw = results[3];
  var orgLookups = results[4];

  if (!activity) return { status: 'activity_not_found', message: '未找到评分活动', overviewRows: [] };

  var members = membersRaw.map(function (item) { return normalizeMemberFull(item, orgLookups); });
  var rules = normalizeRules(rulesRaw, orgLookups);
  var memberMap = new Map(members.map(function (m) { return [m.id, m]; }));

  // Compute expected scorers per target
  var membersByRuleKey = new Map();
  members.forEach(function (member) {
    var key = getMemberRuleKey(member);
    if (!membersByRuleKey.has(key)) membersByRuleKey.set(key, []);
    membersByRuleKey.get(key).push(member);
  });

  // Build per-target expected scorer set
  var expectedByTarget = new Map();
  members.forEach(function (m) {
    expectedByTarget.set(m.id, { targetId: m.id, expectedScorerKeys: new Set() });
  });

  rules.forEach(function (rule) {
    var scorers = membersByRuleKey.get(makeOrgRuleKey(rule.scorerDepartmentId, rule.scorerIdentityId)) || [];
    rule.clauses.forEach(function (clause) {
      if (!clause.templateConfigs.length) return;
      scorers.forEach(function (scorer) {
        members.forEach(function (target) {
          if (!matchesClauseTarget(target, scorer, clause)) return;
          var row = expectedByTarget.get(target.id);
          if (row) row.expectedScorerKeys.add(getScorerUniqueKey(scorer));
        });
      });
    });
  });

  // Compute submitted scorers per target and score calculation
  var submittedByTarget = new Map();
  var calcMap = new Map();

  recordsRaw.forEach(function (record) {
    var targetId = safeString(record.targetId);
    if (!targetId) return;
    var rule = rules.find(function (r) { return safeString(r._id) === safeString(record.ruleId); }) || {};

    // Track submitted scorer
    var scorerKey = safeString(record.scorerId);
    if (scorerKey) {
      if (!submittedByTarget.has(targetId)) submittedByTarget.set(targetId, new Set());
      submittedByTarget.get(targetId).add(scorerKey);
    }

    // Compute template scores
    var configs = [];
    if (Array.isArray(record.templateConfigs) && record.templateConfigs.length) {
      configs = record.templateConfigs;
    } else {
      var clauses = Array.isArray(rule.clauses) ? rule.clauses : [];
      for (var ci = 0; ci < clauses.length; ci++) {
        configs = configs.concat(Array.isArray(clauses[ci].templateConfigs) ? clauses[ci].templateConfigs : []);
      }
    }

    var answers = Array.isArray(record.answers) ? record.answers : [];
    var answerMap = new Map();
    answers.forEach(function (a, ai) {
      answerMap.set(String(a.questionIndex != null ? a.questionIndex : ai), toNumber(a.score, 0));
    });

    var cursor = 0;
    configs.filter(function (c) { return safeString(c.templateId); }).forEach(function (config) {
      var templateId = safeString(config.templateId);
      var tpl = orgLookups.templatesById && orgLookups.templatesById.get(templateId);
      var qCount = tpl ? (Array.isArray(tpl.questions) ? tpl.questions.length : 0) : 0;
      var score = 0;
      if (qCount) {
        for (var qi = 0; qi < qCount; qi++) score += toNumber(answerMap.get(String(cursor + qi)), 0);
      } else {
        answers.filter(function (a) { return safeString(a.templateId) === templateId; }).forEach(function (a) { score += toNumber(a.score, 0); });
      }
      cursor += qCount;
      var weight = toNumber(config.weight, 0);
      var key = targetId + '||' + templateId;
      if (!calcMap.has(key)) calcMap.set(key, { targetId: targetId, templateId: templateId, weight: weight, templateName: safeString(tpl && tpl.name), recordCount: 0, sumScore: 0 });
      var bucket = calcMap.get(key);
      bucket.recordCount += 1;
      bucket.sumScore += score;
    });
  });

  // Compute final scores per target
  var scoreByTarget = new Map();
  calcMap.forEach(function (item) {
    if (!item.recordCount) return;
    var avg = item.sumScore / item.recordCount;
    var contrib = avg * item.weight;
    var cur = scoreByTarget.get(item.targetId) || { finalScore: 0 };
    cur.finalScore += contrib;
    scoreByTarget.set(item.targetId, cur);
  });

  var activityName = safeString(activity.name);
  var overviewRows = members.map(function (member) {
    var exp = expectedByTarget.get(member.id) || { expectedScorerKeys: new Set() };
    var sub = submittedByTarget.get(member.id) || new Set();
    var expCount = Math.max(exp.expectedScorerKeys.size, sub.size);
    var subCount = sub.size;
    var scoreData = scoreByTarget.get(member.id) || { finalScore: 0 };
    return {
      name: member.name,
      studentId: member.studentId,
      department: member.department,
      identity: member.identity,
      workGroup: member.workGroup || '',
      finalScore: roundScore(scoreData.finalScore),
      expectedScorerCount: expCount,
      submittedScorerCount: subCount,
      completionRate: expCount ? Number(((subCount / expCount) * 100).toFixed(2)) : 0
    };
  });

  return { status: 'success', activityName: activityName, overviewRows: overviewRows };
}

async function buildDetailExportPayload(activityId) {
  var results = await Promise.all([
    db.collection('score_activities').doc(activityId).get().catch(function () { return { data: null }; }),
    getAllRecords(db.collection('hr_info')),
    getAllRecords(db.collection('rate_target_rules').where({ activityId: activityId })),
    getAllRecords(db.collection('score_records').where({ activityId: activityId })),
    fetchOrgLookups()
  ]);

  var activity = results[0].data;
  var membersRaw = results[1];
  var rulesRaw = results[2];
  var recordsRaw = results[3];
  var orgLookups = results[4];

  if (!activity) return { status: 'activity_not_found', message: '未找到评分活动', detailRows: [] };

  var memberMap = new Map();
  membersRaw.forEach(function (item) {
    var m = normalizeMemberFull(item, orgLookups);
    memberMap.set(m.id, m);
  });

  var rules = normalizeRules(rulesRaw, orgLookups);
  var activityName = safeString(activity.name);
  var detailRows = [];

  recordsRaw.forEach(function (record) {
    var scorer = memberMap.get(safeString(record.scorerId)) || {};
    var target = memberMap.get(safeString(record.targetId)) || {};
    var rule = rules.find(function (r) { return safeString(r._id) === safeString(record.ruleId); }) || {};

    var configs = [];
    if (Array.isArray(record.templateConfigs) && record.templateConfigs.length) {
      configs = record.templateConfigs;
    } else {
      (Array.isArray(rule.clauses) ? rule.clauses : []).forEach(function (clause) {
        configs = configs.concat(Array.isArray(clause.templateConfigs) ? clause.templateConfigs : []);
      });
    }

    var answers = Array.isArray(record.answers) ? record.answers : [];
    var answerMap = new Map();
    answers.forEach(function (a, ai) {
      answerMap.set(String(a.questionIndex != null ? a.questionIndex : ai), toNumber(a.score, 0));
    });

    var cursor = 0;
    var uniqueConfigs = [];
    var seenTpl = {};
    configs.filter(function (c) { return safeString(c.templateId); }).forEach(function (config) {
      var tid = safeString(config.templateId);
      if (seenTpl[tid]) return;
      seenTpl[tid] = true;
      uniqueConfigs.push(config);
    });

    uniqueConfigs.forEach(function (config) {
      var templateId = safeString(config.templateId);
      var tpl = orgLookups.templatesById && orgLookups.templatesById.get(templateId);
      var questions = tpl ? (Array.isArray(tpl.questions) ? tpl.questions : []) : [];
      var weight = toNumber(config.weight, 0);

      var templateScore = 0;
      questions.forEach(function (q, qi) {
        var qScore = toNumber(answerMap.get(String(cursor + qi)), 0);
        templateScore += qScore;
        detailRows.push({
          scorerName: safeString(scorer.name),
          scorerStudentId: safeString(scorer.studentId),
          scorerDepartment: safeString(scorer.department),
          scorerIdentity: safeString(scorer.identity),
          scorerWorkGroup: safeString(scorer.workGroup),
          targetName: safeString(target.name),
          targetStudentId: safeString(target.studentId),
          targetDepartment: safeString(target.department),
          targetIdentity: safeString(target.identity),
          targetWorkGroup: safeString(target.workGroup),
          templateName: safeString(config.templateName) || safeString(tpl && tpl.name),
          question: safeString(q.question),
          score: qScore,
          maxValue: toNumber(q.maxValue, 0),
          weight: weight,
          submittedAt: record.submittedAt || ''
        });
      });
      cursor += questions.length;
    });
  });

  return { status: 'success', activityName: activityName, detailRows: detailRows };
}

function formatExportDate(value) {
  if (!value) return '';
  var d = value instanceof Date ? value : (value && typeof value.toDate === 'function' ? value.toDate() : new Date(value));
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function buildReportDefinition(reportType, payload) {
  const baseName = payload.activityName || '评分活动';

  if (reportType === 'overview') {
    return {
      fileName: `${baseName}_总分速览`,
      sheetName: '总分速览',
      headers: [
        { key: 'name', label: '姓名' },
        { key: 'studentId', label: '学号' },
        { key: 'department', label: '部门' },
        { key: 'identity', label: '身份' },
        { key: 'workGroup', label: '工作分工（职能组）' },
        { key: 'finalScore', label: '最终得分' },
        { key: 'submittedScorerCount', label: '已评人数' },
        { key: 'expectedScorerCount', label: '应评人数' },
        { key: 'completionRate', label: '完成率(%)' }
      ],
      rows: payload.overviewRows || []
    };
  }

  if (reportType === 'detail') {
    return {
      fileName: `${baseName}_评分明细`,
      sheetName: '评分明细',
      headers: [
        { key: 'scorerName', label: '评分人姓名' },
        { key: 'scorerStudentId', label: '评分人学号' },
        { key: 'scorerDepartment', label: '评分人部门' },
        { key: 'scorerIdentity', label: '评分人身份' },
        { key: 'targetName', label: '被评人姓名' },
        { key: 'targetStudentId', label: '被评人学号' },
        { key: 'targetDepartment', label: '被评人部门' },
        { key: 'targetIdentity', label: '被评人身份' },
        { key: 'templateName', label: '评分模板' },
        { key: 'question', label: '题目' },
        { key: 'score', label: '得分' },
        { key: 'maxValue', label: '最高分' },
        { key: 'weight', label: '权重' },
        { key: 'submittedAt', label: '提交时间' }
      ],
      rows: (payload.detailRows || []).map(function (row) {
        var r = {};
        Object.keys(row).forEach(function (k) { r[k] = row[k]; });
        r.submittedAt = formatExportDate(row.submittedAt);
        return r;
      })
    };
  }

  return {
    fileName: `${baseName}_评分人完成率`,
    sheetName: '评分人完成率',
    headers: [
      { key: 'scorerName', label: '评分人姓名' },
      { key: 'scorerStudentId', label: '评分人学号' },
      { key: 'department', label: '所属部门' },
      { key: 'identity', label: '身份' },
      { key: 'workGroup', label: '工作分工（职能组）' },
      { key: 'expectedCount', label: '应评分人数' },
      { key: 'submittedCount', label: '已评分人数' },
      { key: 'pendingCount', label: '待评分人数' },
      { key: 'completionRate', label: '完成率(%)' }
    ],
    rows: payload.completionRows
  };
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const activityId = safeString(event.activityId);
  const reportType = safeString(event.reportType) || 'completion';
  const format = safeString(event.format) || 'csv';
  const filters = event.filters || {};

  if (!activityId) {
    return {
      status: 'invalid_params',
      message: '请先选择评分活动'
    };
  }

  const operator = await ensureAdmin(openid);
  if (!operator) {
    return {
      status: 'forbidden',
      message: '没有管理权限'
    };
  }

  var payload;
  if (reportType === 'overview') {
    payload = await buildOverviewExportPayload(activityId);
  } else if (reportType === 'detail') {
    payload = await buildDetailExportPayload(activityId);
  } else {
    payload = await buildScorerCompletionPayload(activityId);
  }

  if (payload.status !== 'success') {
    return payload;
  }

  const filteredPayload = applyFiltersToRows(payload, filters);
  const report = buildReportDefinition(reportType, filteredPayload);
  const fileContent = format === 'excel'
    ? buildExcelXml(report.sheetName, report.headers, report.rows)
    : buildCsv(report.headers, report.rows);

  return {
    status: 'success',
    fileContent,
    fileName: report.fileName,
    extension: format === 'excel' ? 'xls' : 'csv'
  };
};
