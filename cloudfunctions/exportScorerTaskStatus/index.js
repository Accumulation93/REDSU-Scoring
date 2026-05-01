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
    promises.push(query.skip(i * pageSize).limit(pageSize).get());
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

async function ensureAdmin(openid) {
  const res = await db.collection('admin_info')
    .where({ openid, bindStatus: 'active' })
    .limit(1)
    .get();
  return res.data[0] || null;
}

function buildReportDefinition(activityName, reportType, rows) {
  if (reportType === 'detail') {
    return {
      fileName: `${activityName}_未完成评分明细`,
      sheetName: '未完成评分明细',
      headers: [
        { key: 'scorerName', label: '评分人姓名' },
        { key: 'scorerStudentId', label: '评分人学号' },
        { key: 'department', label: '所属部门' },
        { key: 'identity', label: '身份' },
        { key: 'workGroup', label: '工作分工（职能组）' },
        { key: 'targetName', label: '未完成被评分人姓名' },
        { key: 'targetStudentId', label: '未完成被评分人学号' },
        { key: 'targetDepartment', label: '被评分人所属部门' },
        { key: 'targetIdentity', label: '被评分人身份' },
        { key: 'targetWorkGroup', label: '被评分人工作分工（职能组）' }
      ],
      rows: rows.flatMap((row) => row.pendingList.map((target) => ({
        scorerName: row.scorerName,
        scorerStudentId: row.scorerStudentId,
        department: row.department,
        identity: row.identity,
        workGroup: row.workGroup,
        targetName: target.targetName,
        targetStudentId: target.targetStudentId,
        targetDepartment: target.targetDepartment,
        targetIdentity: target.targetIdentity,
        targetWorkGroup: target.targetWorkGroup
      })))
    };
  }

  return {
    fileName: `${activityName}_未完成评分概览`,
    sheetName: '未完成评分概览',
    headers: [
      { key: 'scorerName', label: '评分人姓名' },
      { key: 'scorerStudentId', label: '评分人学号' },
      { key: 'department', label: '所属部门' },
      { key: 'identity', label: '身份' },
      { key: 'workGroup', label: '工作分工（职能组）' },
      { key: 'expectedCount', label: '应评分人数' },
      { key: 'submittedCount', label: '已评分人数' },
      { key: 'pendingCount', label: '未评分人数' },
      { key: 'completionRate', label: '完成率(%)' }
    ],
    rows
  };
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const activityId = safeString(event.activityId);
    const reportType = safeString(event.reportType) || 'summary';
    const format = safeString(event.format) || 'csv';
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
        scorerKey: makeOrgRuleKey(scorerDepartmentId, scorerIdentityId) || safeString(item.scorerKey),
        clauses: Array.isArray(item.clauses) ? item.clauses.map((clause) => normalizeRuleClause(clause, orgLookups)) : []
      };
    });

    const rows = applyFilters(buildTaskRows(members, rules, records), filters);
    const activityName = safeString(activityRes.data.name) || '评分活动';
    const report = buildReportDefinition(activityName, reportType, rows);
    const fileContent = format === 'excel'
      ? buildExcelXml(report.sheetName, report.headers, report.rows)
      : buildCsv(report.headers, report.rows);

    return {
      status: 'success',
      fileName: report.fileName,
      extension: format === 'excel' ? 'xls' : 'csv',
      fileContent
    };
  } catch (error) {
    return {
      status: 'error',
      message: safeString(error && (error.message || error.errMsg)) || '导出未完成评分任务失败'
    };
  }
};
